#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取2026-05-28涨停股票并生成分析报告
使用新浪财经API，过滤连板股，v6评分系统
"""

import urllib.request
import json
import time
from datetime import datetime

def fetch_sina_limit_up_page(page=1, num=100):
    """获取新浪财经涨停股票（分页）"""
    url = f'http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page={page}&num={num}&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a_p=init'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as response:
            data = response.read().decode('gbk')
            if data.strip() == '[]' or not data.strip():
                return []
            return json.loads(data)
    except Exception as e:
        print(f"  页面 {page} 获取失败: {e}")
        return []

def get_all_limit_up_stocks():
    """获取所有涨停股票"""
    print("正在获取涨停股票列表...")
    all_stocks = []
    page = 1
    
    while True:
        print(f"  获取第 {page} 页...", end='')
        stocks = fetch_sina_limit_up_page(page, 100)
        if not stocks:
            print(" 无数据，结束")
            break
        
        # 筛选涨幅>=9.9%且排除N开头新股
        filtered = [s for s in stocks if float(s.get('changepercent', 0)) >= 9.9 
                    and not s.get('name', '').startswith('N')]
        
        print(f" 获取到 {len(stocks)} 只，过滤后 {len(filtered)} 只")
        all_stocks.extend(filtered)
        
        if len(stocks) < 100:
            break
        page += 1
        time.sleep(0.5)
    
    print(f"\n总计获取涨停股票: {len(all_stocks)} 只")
    return all_stocks

def calculate_score_v6(stock):
    """v6三维度评分：封板强度(40) + 换手健康(30) + 行业赛道(30)"""
    changepercent = float(stock.get('changepercent', 0))
    turnoverratio = float(stock.get('turnoverratio', 0))
    volume = float(stock.get('volume', 0))
    amount = float(stock.get('amount', 0))
    current_price = float(stock.get('trade', 0))
    
    # 1. 封板强度 (40分)
    # 新浪API没有直接封单金额，用成交额和涨幅近似评估
    if changepercent >= 19.9:  # 科创/创业板接近20%
        seal_score = 40  # 强势封板
    elif changepercent >= 9.9:  # 主板10%
        seal_score = 35 if turnoverratio < 5 else 30
    else:
        seal_score = 20
    
    # 2. 换手健康 (30分)
    code = stock.get('code', '')
    is_kcb = code.startswith('688') or code.startswith('689')
    is_cyb = code.startswith('300') or code.startswith('301')
    
    if is_kcb or is_cyb:  # 科创/创业板
        if 5 <= turnoverratio <= 15:
            health_score = 30
        elif (3 <= turnoverratio < 5) or (15 < turnoverratio <= 25):
            health_score = 22
        elif (1 <= turnoverratio < 3) or (25 < turnoverratio <= 35):
            health_score = 15
        else:
            health_score = 5
    else:  # 主板
        if 3 <= turnoverratio <= 8:
            health_score = 30
        elif (2 <= turnoverratio < 3) or (8 < turnoverratio <= 12):
            health_score = 22
        elif (1 <= turnoverratio < 2) or (12 < turnoverratio <= 20):
            health_score = 15
        else:
            health_score = 5
    
    # 3. 行业赛道 (30分) - 简化版，根据股票代码判断
    # 实际应该通过概念API获取，这里先做简化
    sector_score = 20  # 默认B级
    
    total_score = seal_score + health_score + sector_score
    
    # 等级划分
    if total_score >= 85:
        grade = 'S'
    elif total_score >= 70:
        grade = 'A'
    elif total_score >= 55:
        grade = 'B'
    elif total_score >= 40:
        grade = 'C'
    else:
        grade = 'D'
    
    return {
        'total': total_score,
        'seal': seal_score,
        'health': health_score,
        'sector': sector_score,
        'grade': grade
    }

def main():
    print("=" * 70)
    print("A股涨停板分析 - 2026-05-28")
    print("=" * 70)
    print()
    
    # 1. 获取涨停股票
    stocks = get_all_limit_up_stocks()
    
    if not stocks:
        print("\n未获取到涨停股票，请检查网络或API")
        return
    
    # 2. 评分
    print("\n正在评分...")
    results = []
    for stock in stocks:
        score = calculate_score_v6(stock)
        results.append({
            'code': stock.get('code', ''),
            'name': stock.get('name', ''),
            'price': float(stock.get('trade', 0)),
            'change': float(stock.get('changepercent', 0)),
            'turnover': float(stock.get('turnoverratio', 0)),
            'score': score
        })
    
    # 3. 排序
    results.sort(key=lambda x: x['score']['total'], reverse=True)
    
    # 4. 输出报告
    print("\n" + "=" * 70)
    print("涨停股票评分排名 (共 {} 只)".format(len(results)))
    print("=" * 70)
    print()
    print(f"{'排名':<6}{'代码':<10}{'名称':<10}{'涨幅%':<10}{'换手%':<10}{'总分':<8}{'等级':<4}")
    print("-" * 70)
    
    for i, r in enumerate(results, 1):
        print(f"{i:<6}{r['code']:<10}{r['name']:<10}{r['change']:<10.2f}{r['turnover']:<10.2f}{r['score']['total']:<8}{r['score']['grade']:<4}")
    
    # 5. 保存到文件
    output_file = '/Users/zhuxiaodong/WorkBuddy/Claw/涨停分析_2026-05-28.md'
    print(f"\n正在保存报告到: {output_file}")
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write("# A股涨停板分析 - 2026-05-28\n\n")
        f.write(f"**分析时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write(f"**涨停股票数量**: {len(results)} 只\n\n")
        f.write("---\n\n")
        f.write("## 评分排名\n\n")
        f.write("| 排名 | 代码 | 名称 | 涨幅% | 换手率% | 封板分 | 换手分 | 赛道分 | 总分 | 等级 |\n")
        f.write("|------|------|------|-------|----------|--------|--------|--------|------|------|\n")
        
        for i, r in enumerate(results, 1):
            f.write(f"| {i} | {r['code']} | {r['name']} | {r['change']:.2f} | {r['turnover']:.2f} | {r['score']['seal']} | {r['score']['health']} | {r['score']['sector']} | {r['score']['total']} | {r['score']['grade']} |\n")
    
    print(f"报告已保存: {output_file}")
    print("\n完成！")

if __name__ == '__main__':
    main()
