#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
涨停板分析主运行脚本 (v5)

支持：
1. 工作日：获取真实涨停数据
2. 自动保存到JSON数据库
3. 两阶段模式：盘中过滤（intraday）+ 收盘完整分析（market-close）
注意：非交易日（周末/节假日）不进行分析
"""

import os
import sys
import argparse
from datetime import datetime, timedelta

# 添加当前目录到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_limit_up import fetch_limit_up_data
from objective_score import analyze_limit_up, rank_stocks
from generate_report import generate_markdown_report
from limit_up_db import LimitUpDB
from top_stock_tracker import run_tracking
from stock_deep_analysis import deep_analyze_top5


def save_to_db(stocks: list, today_str: str, db, analysis=None, dry_run: bool = False):
    """
    保存今日涨停数据到数据库，并补充昨日涨停的次日跟踪数据
    同时保存今日评分最高的股票信息（供明日跟踪使用）
    """
    if not stocks:
        return

    if dry_run:
        print(f"[DB] 演示模式，仅打印不保存")
        print(f"[DB] 应保存 {today_str} 的 {len(stocks)} 只涨停数据")
        return

    # 1. 保存今日涨停原始数据
    raw_stocks = []
    for s in stocks:
        raw = {
            'code': s.get('code', ''),
            'name': s.get('name', ''),
            'change_pct': s.get('change_pct', 0),
            'turnover': s.get('turnover', 0),
            'sealed_amount': s.get('sealed_amount', 0),
            'sealed_ratio': s.get('sealed_ratio', 0),
            'float_cap_yi': s.get('float_cap_yi', 0),
            'is_chip': s.get('is_chip', False),
            'open_gap': s.get('open_gap', 0),
            'can_buy': s.get('can_buy', True),
            'prev_close': s.get('prev_close', 0),
            'open_price': s.get('open', s.get('open_price', 0)),
            'current_price': s.get('current_price', 0),
        }
        raw_stocks.append(raw)

    # 1.1 保存评分最高的股票信息
    top_stock_info = None
    if analysis:
        # 优先取主板最高分，如果主板为空则取科创板
        all_scored = analysis.get('normal_stocks', []) + analysis.get('chip_stocks', [])
        if all_scored:
            best = all_scored[0]  # 已按分数降序排列
            top_stock_info = {
                'code': best.get('code', ''),
                'name': best.get('name', ''),
                'change_pct': best.get('change_pct', 0),
                'score': best.get('总分', 0),
                'grade': best.get('等级', '?'),
                'is_chip': best.get('is_chip', False),
            }

    db.save_day(today_str, raw_stocks, top_stock=top_stock_info)
    print(f"[DB] ✓ 已保存 {today_str} 的 {len(raw_stocks)} 只涨停原始数据")
    if top_stock_info:
        print(f"[DB] ✓ 最高分股票: {top_stock_info['name']}({top_stock_info['code']}) "
              f"{top_stock_info['score']}分 {top_stock_info['grade']}级")

    # 2. 尝试为昨天添加跟踪数据
    yesterday = (datetime.strptime(today_str, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    yesterday_data = db.get_day(yesterday)

    if yesterday_data:
        yesterday_stocks = yesterday_data.get('stocks', [])
        if yesterday_stocks:
            print(f"[DB] 为昨天({yesterday})的 {len(yesterday_stocks)} 只涨停股添加今日跟踪...")
            followup_stocks = []

            for y_stock in yesterday_stocks:
                y_code = y_stock.get('code', '')
                y_prev_close = y_stock.get('prev_close', 0)

                today_stock = next((s for s in raw_stocks if s['code'] == y_code), None)

                if today_stock:
                    today_open = today_stock.get('open_price', 0)
                    today_close = today_stock.get('current_price', 0)
                    today_pct = today_stock.get('change_pct', 0)
                else:
                    today_open = 0
                    today_close = 0
                    today_pct = 0

                if y_prev_close > 0 and today_open > 0:
                    open_profit = (today_open - y_prev_close) / y_prev_close * 100
                    close_profit = (today_close - y_prev_close) / y_prev_close * 100 if today_close > 0 else 0
                    can_buy = y_stock.get('can_buy', True)
                else:
                    open_profit = 0
                    close_profit = 0
                    can_buy = False

                followup_stocks.append({
                    'code': y_code,
                    'name': y_stock.get('name', ''),
                    'prev_close': y_prev_close,
                    'next_open': today_open,
                    'next_close': today_close,
                    'next_pct': today_pct,
                    'open_profit': open_profit,
                    'close_profit': close_profit,
                    'can_buy': can_buy,
                })

            db.add_follow_up(yesterday, today_str, followup_stocks)

            can_buy_count = sum(1 for s in followup_stocks if s['can_buy'])
            open_profitable = sum(1 for s in followup_stocks if s['open_profit'] > 0)
            close_profitable = sum(1 for s in followup_stocks if s['close_profit'] > 0)
            print(f"[DB]   可买入 {can_buy_count} 只，开盘盈利 {open_profitable} 只，收盘盈利 {close_profitable} 只")

            for s in followup_stocks:
                tag = "✓" if s['open_profit'] > 0 else "✗"
                ctag = "✓" if s['close_profit'] > 0 else "✗"
                print(f"[DB]   {s['code']} {s['name']}: 开盘{s['open_profit']:+.2f}%{tag} 收盘{s['close_profit']:+.2f}%{ctag}")
    else:
        print(f"[DB] 无昨天({yesterday})的涨停数据，跳过跟踪")


def determine_mode_from_time():
    """根据当前时间自动判断应该执行哪种模式"""
    now = datetime.now()
    hour, minute = now.hour, now.minute
    current_minutes = hour * 60 + minute

    if current_minutes < 9 * 60 + 30:
        return 'premarket'  # 盘前，不执行
    elif current_minutes <= 15 * 60:
        return 'intraday'   # 9:30-15:00 盘中过滤
    elif current_minutes <= 15 * 60 + 5:
        return 'waiting'    # 15:00-15:05 等待数据更新
    else:
        return 'market-close'  # 15:05后 收盘完整分析


def run_intraday_filter():
    """阶段一：盘中过滤简报 - 只输出简短信息，不做完整分析"""
    print("=" * 70)
    print("A股涨停板 · 盘中过滤简报")
    print("=" * 70)

    today_str = datetime.now().strftime("%Y-%m-%d")
    weekday = datetime.now().weekday()

    if weekday >= 5:
        print("\n今日非交易日，不执行盘中过滤")
        return

    print(f"\n日期: {today_str}")
    print("状态: 盘中数据，仅供参考（不构成买卖建议）")
    print()

    try:
        stocks = fetch_limit_up_data(first_limit_only=True)
    except Exception as e:
        print(f"获取数据失败: {e}")
        return

    if not stocks:
        print("当前无涨停股")
        return

    print(f"当前涨停股: {len(stocks)} 只")
    print()

    # 快速评分
    try:
        analysis = analyze_limit_up(stocks)
    except Exception as e:
        print(f"评分失败: {e}")
        return

    # 只输出TOP5简报
    all_scored = analysis.get('normal_stocks', []) + analysis.get('chip_stocks', [])
    all_scored.sort(key=lambda x: x.get('总分', 0), reverse=True)

    print("-" * 60)
    print("初步评分 TOP5（盘中数据，随时变化）")
    print("-" * 60)
    for s in all_scored[:5]:
        code = s.get('code', '')
        name = s.get('name', '')
        score = s.get('总分', 0)
        grade = s.get('等级', '?')
        pct = s.get('change_pct', 0)
        turnover = s.get('turnover', 0)
        chip_tag = ' [科创]' if s.get('is_chip') else ''
        print(f"  {code} {name}{chip_tag}  评分{score:.0f}分 {grade}级  涨幅{pct:+.1f}%  换手{turnover:.1f}%")

    print()
    print("提示: 完整复盘报告将在收盘后（15:05）自动生成")


def run_market_close_analysis(args):
    """阶段二：收盘完整分析 - 完整评分、深度分析、生成报告"""
    print("=" * 70)
    print("A股涨停板复盘分析（收盘完整版）")
    print("=" * 70)

    today = datetime.now()
    weekday = today.weekday()
    is_trading_day = weekday < 5
    today_str = today.strftime("%Y-%m-%d")

    print(f"\n日期: {today_str} {today.strftime('%A')}")

    if is_trading_day:
        print("状态: 收盘后分析，使用最终数据...")
        stocks = fetch_limit_up_data(first_limit_only=True)
    else:
        print("\n今日非交易日，不进行分析（周末/节假日无交易数据）")
        print("=" * 70)
        return None

    if not stocks:
        print("\n没有涨停数据")
        return

    print(f"\n共获取 {len(stocks)} 只涨停股")

    print("\n正在进行客观评分...")
    analysis = analyze_limit_up(stocks)

    # 保存到数据库
    if not args.no_db:
        db = LimitUpDB()
        save_to_db(stocks, today_str, db, analysis=analysis, dry_run=args.dry_run)

        # 跟踪前一日最高分股票的今日表现
        if not args.dry_run:
            try:
                xlsx_path = os.path.expanduser('~/ClawData/WorkBuddy/top-stock-tracking.xlsx')
                run_tracking(today_str, db, xlsx_path=xlsx_path)
            except Exception as e:
                print(f"[跟踪] 跟踪过程出错: {e}")

    # 显示结果
    print("\n" + "=" * 70)
    print("分析结果")
    print("=" * 70)

    print(f"\n平均评分: {analysis['avg_score']:.1f}分")
    print(f"S级: {len(analysis['s_class'])} 只")
    print(f"A级: {len(analysis['a_class'])} 只")
    print(f"B级: {len(analysis['b_class'])} 只")
    print(f"C级: {len(analysis['c_class'])} 只")
    print(f"D级: {len(analysis['d_class'])} 只")

    print("\n" + "-" * 70)
    print("评分TOP10（主板）— v6三维度评分")
    print("-" * 70)
    print(f"{'排名':<4} {'代码':<8} {'名称':<10} {'涨停':<8} {'换手':<8} {'封板':<6} {'赛道':<6} {'评分':<8} {'等级':<4} {'仓位'}")
    print("-" * 70)

    for s in analysis['normal_stocks'][:10]:
        pos = s.get('仓位建议', '-')
        print(f"{s['排名']:<4} {s['code']:<8} {s['name']:<10} "
              f"{s['change_pct']:>+6.1f}% {s['turnover']:>6.1f}% "
              f"{s['封板强度']:>3}/40 {s['行业赛道']:>3}/30 "
              f"{s['总分']:>5}/100  {s['等级']:<4} {pos}")

    # 深度分析TOP10
    print(f"\n正在进行TOP10深度分析...")
    deep_results = deep_analyze_top5(analysis['normal_stocks'], top_n=10)

    output_dir = os.path.expanduser('~/ClawData/WorkBuddy')
    os.makedirs(output_dir, exist_ok=True)
    report_path = os.path.join(output_dir, f'limit-up-report-{today_str}.md')

    print(f"\n正在生成报告...")
    report = generate_markdown_report(analysis, report_path, deep_results=deep_results)

    print(f"\n报告已保存: {report_path}")
    print("\n" + "=" * 70)
    print("分析完成!")
    print("=" * 70)

    return analysis


def main():
    parser = argparse.ArgumentParser(description='A股涨停板复盘分析 (v5)')
    parser.add_argument('--mode', choices=['intraday', 'market-close', 'auto'],
                        default='auto',
                        help='执行模式: intraday=盘中过滤, market-close=收盘完整分析, auto=自动判断(默认)')
    parser.add_argument('--no-db', action='store_true', help='不保存到数据库')
    parser.add_argument('--dry-run', action='store_true', help='仅演示，不保存')
    parser.add_argument('--db-stats', action='store_true', help='显示数据库统计')
    parser.add_argument('--db-analyze', action='store_true', help='显示胜率分析')
    args = parser.parse_args()

    if args.db_stats or args.db_analyze:
        db = LimitUpDB()
        if args.db_stats:
            stats = db.get_stats()
            print("="*60)
            print("涨停数据库统计")
            print("="*60)
            print(f"数据库路径: {stats['db_path']}")
            print(f"总交易日数: {stats['total_days']}")
            print(f"总涨停股数: {stats['total_stocks']}")
            print(f"已跟踪数据: {stats['days_with_followup']} 天")
            print(f"数据范围: {stats['first_date']} ~ {stats['last_date']}")
            print()
            for d in db.get_all_days():
                day = db.get_day(d)
                count = day.get("total_count", 0)
                tag = "✓" if day.get("followup") else ""
                print(f"  {d}: {count}只涨停 {tag}")
        if args.db_analyze:
            db = LimitUpDB()
            results = db.analyze_win_rate(min_sample=2)
            print("="*60)
            print("涨停胜率分析")
            print("="*60)
            print(results["conclusion"])
        return

    # 确定执行模式
    mode = args.mode
    if mode == 'auto':
        mode = determine_mode_from_time()
        print(f"[自动判断] 当前时间模式: {mode}")

    if mode == 'premarket':
        print("当前为盘前时间（<9:30），不执行分析")
        print("盘中过滤将在9:35自动执行")
        print("收盘完整分析将在15:05自动执行")
        return
    elif mode == 'waiting':
        print("收盘刚结束（15:00-15:05），等待数据更新...")
        print("完整分析将在15:05自动执行")
        return
    elif mode == 'intraday':
        run_intraday_filter()
    elif mode == 'market-close':
        run_market_close_analysis(args)
    else:
        print(f"未知模式: {mode}")
        return


if __name__ == '__main__':
    main()
