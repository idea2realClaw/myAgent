#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试脚本：查询QCOM和TLT的实时价格
"""

from stock_price_tool import StockPriceFetcher

def main():
    print("=" * 70)
    print("股票价格查询测试 - QCOM & TLT")
    print("=" * 70)

    fetcher = StockPriceFetcher()

    # 查询QCOM
    print("\n【高通 QCOM】")
    qcom_result = fetcher.get_stock_price('QCOM')
    print(fetcher.format_price_output(qcom_result))

    # 查询TLT
    print("\n【TLT（20年以上美国国债ETF）】")
    tlt_result = fetcher.get_stock_price('TLT')
    print(fetcher.format_price_output(tlt_result))

    # 批量查询
    print("\n【批量查询对比】")
    df = fetcher.get_multiple_stocks(['QCOM', 'TLT'])
    if not df.empty and 'price' in df.columns:
        print("\n代码        名称                    价格        涨跌幅        更新时间")
        print("-" * 70)
        for _, row in df.iterrows():
            if 'error' not in row:
                symbol = row['symbol']
                name = row['name'][:20] if 'name' in row else symbol
                price = row['price']
                change_percent = row['change_percent']
                update_time = row['update_time'].split(' ')[1][:5]
                print(f"{symbol:<12} {name:<20} {price:>10} {change_percent:>10}% {update_time}")

if __name__ == "__main__":
    main()
