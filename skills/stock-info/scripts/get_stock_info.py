#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
股票基本信息获取脚本
数据来源：腾讯API（行情）+ 东方财富API（财务）

重要说明：
1. 总市值从东方财富API (f116) 直接获取
2. 流通市值 = 当前价 × 流通股本 (f85)
3. 总股本 = f84，流通股本 = f85（单位：股）
4. 市净率 = f167/100，市盈率 = f176/10
5. 股息率 = f173（已经是%）

错误教训（2026-03-28）：
- 之前错误地把东方财富API的f162/f163理解为"万元"，导致市值计算错误
- 正确理解：f116 = 总市值（元），f84/f85 = 股本（股）
- 解决方案：总市值用API直接值，流通市值用 Python = 股价×流通股本 计算
"""

import urllib.request
import json
import re
import time
from typing import Dict, List, Optional


def get_stock_info(codes: List[str]) -> List[Dict]:
    """
    获取股票基本信息

    Args:
        codes: 股票代码列表，如 ['002361', '600519']

    Returns:
        股票信息列表
    """
    results = []

    for code in codes:
        info = get_single_stock_info(code)
        if info:
            results.append(info)

    return results


def get_single_stock_info(code: str, retry: int = 3) -> Optional[Dict]:
    """
    获取单只股票信息

    Args:
        code: 股票代码（6位数字）
        retry: 重试次数

    Returns:
        股票信息字典
    """
    # 判断市场
    if code.startswith('6'):
        market = 'sh'
        secid = f'1.{code}'
    else:
        market = 'sz'
        secid = f'0.{code}'

    # 1. 获取腾讯行情数据（稳定）
    qt_url = f'https://qt.gtimg.cn/q={market}{code}'
    qt_req = urllib.request.Request(qt_url, headers={'User-Agent': 'Mozilla/5.0'})

    try:
        qt_response = urllib.request.urlopen(qt_req, timeout=10)
        qt_data = qt_response.read().decode('gbk')
        qt_fields = qt_data.split('~')
    except Exception as e:
        print(f"获取 {code} 行情失败: {e}")
        return None

    current_price = float(qt_fields[3]) if qt_fields[3] else 0
    name = qt_fields[1] if qt_fields[1] else ''

    # 2. 获取东方财富财务数据（可能不稳定）
    em_url = f'https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f57,f58,f84,f85,f116,f167,f173,f176,f177&ut=b2884a393a59ad64002292a3e90d46a5'

    em_data = None
    for attempt in range(retry):
        try:
            em_req = urllib.request.Request(em_url, headers={'User-Agent': 'Mozilla/5.0'})
            em_response = urllib.request.urlopen(em_req, timeout=20)
            em_raw = em_response.read().decode('utf-8')

            # 解析JSONP
            em_match = re.search(r'jQuery\((.*)\)', em_raw)
            if em_match:
                em_json = json.loads(em_match.group(1))
                em_data = em_json.get('data', {})
                break
        except Exception as e:
            if attempt < retry - 1:
                time.sleep(2)
            else:
                print(f"获取 {code} 财务数据失败 (已重试 {retry} 次)")

    # 提取数据
    if em_data:
        total_shares = em_data.get('f84', 0)  # 总股本（股）
        float_shares = em_data.get('f85', 0)  # 流通股本（股）
        total_market_cap = em_data.get('f116', 0)  # 总市值（元）
        float_market_cap = current_price * float_shares if float_shares else 0  # 流通市值 = 股价×股本

        result = {
            'code': code,
            'name': name,
            'current_price': current_price,
            'change_pct': float(qt_fields[32]) if qt_fields[32] else 0,
            'volume': int(qt_fields[6]) if qt_fields[6] else 0,
            'amount': float(qt_fields[37]) if qt_fields[37] else 0,
            'turnover': float(qt_fields[38]) if qt_fields[38] else 0,
            'high': float(qt_fields[33]) if qt_fields[33] else 0,
            'low': float(qt_fields[34]) if qt_fields[34] else 0,
            'open': float(qt_fields[5]) if qt_fields[5] else 0,
            'prev_close': float(qt_fields[4]) if qt_fields[4] else 0,
            'total_shares': total_shares,
            'float_shares': float_shares,
            'total_market_cap': total_market_cap,
            'float_market_cap': float_market_cap,
            'pe_ttm': em_data.get('f176', 0) / 10 if em_data.get('f176') else None,
            'pe_dynamic': em_data.get('f177', 0) / 10 if em_data.get('f177') else None,
            'pb': em_data.get('f167', 0) / 100 if em_data.get('f167') else None,
            'dividend_yield': em_data.get('f173', 0) if em_data.get('f173') else None,
        }
    else:
        # API不可用时，只返回行情数据
        result = {
            'code': code,
            'name': name,
            'current_price': current_price,
            'change_pct': float(qt_fields[32]) if qt_fields[32] else 0,
            'volume': int(qt_fields[6]) if qt_fields[6] else 0,
            'amount': float(qt_fields[37]) if qt_fields[37] else 0,
            'turnover': float(qt_fields[38]) if qt_fields[38] else 0,
            'high': float(qt_fields[33]) if qt_fields[33] else 0,
            'low': float(qt_fields[34]) if qt_fields[34] else 0,
            'open': float(qt_fields[5]) if qt_fields[5] else 0,
            'prev_close': float(qt_fields[4]) if qt_fields[4] else 0,
            'total_shares': 0,
            'float_shares': 0,
            'total_market_cap': 0,
            'float_market_cap': 0,
            'pe_ttm': None,
            'pe_dynamic': None,
            'pb': None,
            'dividend_yield': None,
            'api_warning': '财务数据获取失败，请检查网络连接'
        }

    return result


def format_stock_info(info: Dict) -> str:
    """格式化股票信息输出"""
    if not info:
        return "无数据"

    total_cap_yi = info['total_market_cap'] / 1e8 if info['total_market_cap'] else 0
    float_cap_yi = info['float_market_cap'] / 1e8 if info['float_market_cap'] else 0
    total_shares_yi = info['total_shares'] / 1e8 if info['total_shares'] else 0
    float_shares_yi = info['float_shares'] / 1e8 if info['float_shares'] else 0

    lines = [
        f"{'='*50}",
        f"{info['name']} ({info['code']})",
        f"{'='*50}",
        f"{'实时行情':-^30}",
        f"  当前价格: {info['current_price']:.2f} 元",
        f"  涨跌幅:   {info['change_pct']:+.2f}%",
        f"  今开:     {info['open']:.2f} 元",
        f"  昨收:     {info['prev_close']:.2f} 元",
        f"  最高:     {info['high']:.2f} 元",
        f"  最低:     {info['low']:.2f} 元",
        f"  换手率:   {info['turnover']:.2f}%",
        f"",
        f"{'股本数据':-^30}",
        f"  总股本:   {info['total_shares']:>15,} 股 = {total_shares_yi:.2f} 亿股",
        f"  流通股本: {info['float_shares']:>15,} 股 = {float_shares_yi:.2f} 亿股",
        f"  流通比例: {info['float_shares']/info['total_shares']*100:.1f}%" if info['total_shares'] else "",
        f"",
        f"{'市值数据':-^30}",
        f"  总市值:   {info['total_market_cap']:>18,.0f} 元 = {total_cap_yi:.2f} 亿元",
        f"  流通市值: {info['float_market_cap']:>18,.0f} 元 = {float_cap_yi:.2f} 亿元",
        f"",
        f"{'估值指标':-^30}",
        f"  市盈率TTM:   {info['pe_ttm']:.2f}" if info['pe_ttm'] else "  市盈率TTM:   N/A",
        f"  动态市盈率:   {info['pe_dynamic']:.2f}" if info['pe_dynamic'] else "  动态市盈率:   N/A",
        f"  市净率:       {info['pb']:.2f}" if info['pb'] else "  市净率:       N/A",
        f"  股息率:       {info['dividend_yield']:.2f}%" if info['dividend_yield'] else "  股息率:       N/A",
    ]

    if info.get('api_warning'):
        lines.append(f"\n⚠️ {info['api_warning']}")

    lines.append(f"{'='*50}")

    return '\n'.join(filter(None, lines))


if __name__ == '__main__':
    import sys

    # 默认测试
    test_codes = ['002361']

    if len(sys.argv) > 1:
        test_codes = sys.argv[1:]

    print(f"获取股票信息: {test_codes}\n")

    stocks = get_stock_info(test_codes)

    for stock in stocks:
        print(format_stock_info(stock))
