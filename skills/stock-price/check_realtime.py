#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""检查云天化和小米港股的实时价格"""

import yfinance as yf
from datetime import datetime

def check_stock(symbol, name):
    """查询单只股票的实时价格"""
    print(f"\n{'='*60}")
    print(f"{name} ({symbol})")
    print(f"{'='*60}")

    ticker = yf.Ticker(symbol)
    info = ticker.info

    # 获取历史数据
    hist = ticker.history(period='1d')

    if not hist.empty:
        latest = hist.iloc[-1]
        now = datetime.now()

        print(f"当前价格: {latest['Close']:.2f}")
        print(f"涨跌额: {latest['Close'] - latest['Open']:.2f}")
        print(f"涨跌幅: {((latest['Close'] - latest['Open']) / latest['Open'] * 100):.2f}%")
        print(f"今开: {latest['Open']:.2f}")
        print(f"最高: {latest['High']:.2f}")
        print(f"最低: {latest['Low']:.2f}")
        print(f"成交量: {int(latest['Volume']):,}")
        print(f"更新时间: {now.strftime('%Y-%m-%d %H:%M:%S')}")
    else:
        print("无法获取实时数据")

    # 检查是否有延迟
    if 'regularMarketPrice' in info:
        print(f"官方报价: {info['regularMarketPrice']:.2f}")

    return not hist.empty

if __name__ == '__main__':
    print("实时股票价格检查")
    print(f"当前时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # 查询云天化
    success1 = check_stock('600096.SS', '云天化')

    # 查询小米
    success2 = check_stock('1810.HK', '小米集团')

    print(f"\n{'='*60}")
    print("数据源说明:")
    print("- yfinance免费数据通常有15-30分钟延迟")
    print("- 非交易时间显示的是最新收盘价")
    print("- 建议对比多个数据源验证准确性")
    print(f"{'='*60}")
