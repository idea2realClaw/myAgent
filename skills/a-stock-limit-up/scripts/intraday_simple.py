#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""简化版盘中涨停分析 - 使用新浪财经API"""

import urllib.request
import urllib.parse
import json
import sys
from datetime import datetime

def get_limit_up_stocks_sina() -> list:
    """从新浪财经API获取涨停股票"""
    url = 'http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
    base_params = {
        'num': 100,
        'sort': 'changepercent',
        'asc': 0,  # 降序
        'node': 'hs_a',
        'symbol': '',
        '_s_r_a': 'init'
    }
    
    all_stocks = []
    
    for page in range(1, 6):  # 最多5页
        params = dict(base_params, page=page)
        query_string = urllib.parse.urlencode(params)
        full_url = f'{url}?{query_string}'
        
        try:
            req = urllib.request.Request(full_url, headers={'User-Agent': 'Mozilla/5.0'})
            response = urllib.request.urlopen(req, timeout=30)
            data = response.read().decode('utf-8')
            
            stocks = json.loads(data)
            if not stocks:
                break
                
            # 筛选涨停股（涨幅>=9.9%），排除N开头的新股
            limit_up = [s for s in stocks if float(s.get('changepercent', 0)) >= 9.9]
            limit_up = [s for s in limit_up if not str(s.get('name', '')).startswith('N')]
            
            all_stocks.extend(limit_up)
            
            # 如果这页数据少于100条，说明已到末页
            if len(stocks) < 100:
                break
                
        except Exception as e:
            print(f"获取第{page}页失败: {e}")
            break
    
    return all_stocks


def calculate_score(stock: dict) -> tuple:
    """计算简化评分（封板强度+换手健康+行业赛道）"""
    changepercent = float(stock.get('changepercent', 0))
    turnoverratio = float(stock.get('turnoverratio', 0))  # 修复：正确字段名（无下划线）
    nmc = float(stock.get('nmc', 0)) * 10000  # 新浪是万元，转成元
    code = stock.get('code', '')
    
    # 简化评分：由于缺少封单金额，主要基于涨幅和换手率
    # 封板强度：基于涨幅（越接近10%越强）
    if changepercent >= 10:
        seal_score = 40
    elif changepercent >= 9.9:
        seal_score = 35
    else:
        seal_score = 20
    
    # 换手健康：基于换手率
    if 3 <= turnoverratio <= 8:
        turnover_score = 30
    elif 2 <= turnoverratio < 3 or 8 < turnoverratio <= 12:
        turnover_score = 22
    elif 1 <= turnoverratio < 2 or 12 < turnoverratio <= 20:
        turnover_score = 15
    else:
        turnover_score = 5
    
    # 行业赛道：简化，暂时给中等分数
    # TODO: 可以通过股票代码判断行业
    sector_score = 20
    
    total = seal_score + turnover_score + sector_score
    
    # 等级
    if total >= 85:
        grade = 'S'
    elif total >= 70:
        grade = 'A'
    elif total >= 55:
        grade = 'B'
    elif total >= 40:
        grade = 'C'
    else:
        grade = 'D'
    
    return total, grade, seal_score, turnover_score, sector_score


def main():
    print("=" * 70)
    print("A股涨停板 · 盘中简报（简化版）")
    print("=" * 70)
    
    today_str = datetime.now().strftime("%Y-%m-%d")
    print(f"\n日期: {today_str}")
    print("状态: 盘中数据，仅供参考（不构成买卖建议）")
    print()
    
    print("正在获取涨停数据...")
    stocks = get_limit_up_stocks_sina()
    
    if not stocks:
        print("当前无涨停股")
        return
    
    print(f"当前涨停股: {len(stocks)} 只")
    print()
    
    # 评分排序
    scored = []
    for s in stocks:
        total, grade, seal, turnover, sector = calculate_score(s)
        scored.append({
            'code': s.get('code', ''),
            'name': s.get('name', ''),
            'changepercent': float(s.get('changepercent', 0)),
            'turnoverratio': float(s.get('turnoverratio', 0)),  # 修复：正确字段名
            'total': total,
            'grade': grade,
            'seal': seal,
            'turnover': turnover,
            'sector': sector,
        })
    
    scored.sort(key=lambda x: x['total'], reverse=True)
    
    print("-" * 60)
    print("初步评分 TOP10（盘中数据，随时变化）")
    print("-" * 60)
    for i, s in enumerate(scored[:10], 1):
        print(f"{i:2d}. {s['code']} {s['name']:<10s} 评分{s['total']:3d}分 {s['grade']}级  涨幅{s['changepercent']:+.2f}%  换手{s['turnoverratio']:.2f}%")
    
    print()
    print("提示: 完整复盘报告将在收盘后生成（需要封单金额等数据）")
    print("=" * 70)


if __name__ == '__main__':
    main()
