#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实时股票价格查询工具
支持A股、港股、美股实时价格查询
"""

import yfinance as yf
import requests
import pandas as pd
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Union
import json


class StockPriceFetcher:
    """股票价格获取器"""

    def __init__(self):
        self.market_map = {
            'A股': ['CN', 'SH', 'SZ'],
            '港股': ['HK'],
            '美股': ['US']
        }

    def normalize_symbol(self, symbol: str) -> str:
        """标准化股票代码"""
        symbol = symbol.upper().strip()

        # 常见股票名称映射
        name_map = {
            '腾讯': '0700.HK',
            'TCEHY': '0700.HK',
            '阿里巴巴': '9988.HK',
            'BABA': '9988.HK',
            '美团': '3690.HK',
            '小米': '1810.HK',
            '京东': '9618.HK',
            '苹果': 'AAPL',
            '微软': 'MSFT',
            '谷歌': 'GOOGL',
            '亚马逊': 'AMZN',
            '特斯拉': 'TSLA',
            '英伟达': 'NVDA',
            '高通': 'QCOM',
            '贵州茅台': '600519.SS',
            '宁德时代': '300750.SZ',
            '招商银行': '600036.SS',
            '平安银行': '000001.SZ',
            '万科A': '000002.SZ',
            'TLT': 'TLT',
        }

        if symbol in name_map:
            return name_map[symbol]

        # 美股不需要后缀
        if not symbol.isdigit() and not '.' in symbol:
            return symbol

        # 自动添加后缀
        if not '.' in symbol:
            if symbol.isdigit():
                if len(symbol) == 6:
                    if symbol.startswith('6'):
                        symbol += '.SS'
                    elif symbol.startswith(('0', '3')):
                        symbol += '.SZ'
                elif len(symbol) <= 5:
                    symbol = symbol.zfill(5) + '.HK'
            else:
                # 美股代码不加.US后缀
                pass

        # 美股去掉.US后缀（yfinance不需要）
        if '.US' in symbol:
            symbol = symbol.replace('.US', '')

        return symbol

    def get_stock_price(self, symbol: str) -> Dict:
        """获取单只股票的实时价格"""
        symbol = self.normalize_symbol(symbol)

        try:
            ticker = yf.Ticker(symbol)
            info = ticker.info

            # 获取最新价格
            hist = ticker.history(period='2d', interval='1m')
            if len(hist) > 0:
                latest = hist.iloc[-1]
                current_price = latest['Close']
                open_price = latest['Open']
                high_price = latest['High']
                low_price = latest['Low']
                volume = latest['Volume']
            else:
                current_price = info.get('currentPrice', info.get('regularMarketPrice', 0))
                open_price = info.get('regularMarketOpen', 0)
                high_price = info.get('regularMarketDayHigh', 0)
                low_price = info.get('regularMarketDayLow', 0)
                volume = info.get('regularMarketVolume', 0)

            # 计算涨跌幅
            previous_close = info.get('previousClose', current_price)
            change = current_price - previous_close
            change_percent = (change / previous_close * 100) if previous_close != 0 else 0

            # 获取股票名称
            name = info.get('longName', info.get('shortName', symbol))

            result = {
                'symbol': symbol,
                'name': name,
                'price': round(float(current_price), 2),
                'change': round(float(change), 2),
                'change_percent': round(float(change_percent), 2),
                'open': round(float(open_price), 2),
                'high': round(float(high_price), 2),
                'low': round(float(low_price), 2),
                'volume': int(volume) if volume else 0,
                'previous_close': round(float(previous_close), 2),
                'currency': info.get('currency', 'USD'),
                'update_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            }

            return result

        except Exception as e:
            return {
                'symbol': symbol,
                'error': str(e),
                'update_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            }

    def get_multiple_stocks(self, symbols: List[str]) -> pd.DataFrame:
        """批量获取多只股票价格"""
        results = []
        for symbol in symbols:
            result = self.get_stock_price(symbol)
            results.append(result)

        df = pd.DataFrame(results)

        return df

    def get_historical_data(self, symbol: str, period: str = '1mo') -> pd.DataFrame:
        """获取历史价格数据"""
        symbol = self.normalize_symbol(symbol)

        try:
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period=period)

            if hist.empty:
                return pd.DataFrame()

            hist['Change'] = hist['Close'] - hist['Open']
            hist['Change_Percent'] = (hist['Change'] / hist['Open'] * 100).round(2)

            return hist

        except Exception as e:
            print(f"获取历史数据失败: {e}")
            return pd.DataFrame()

    def format_price_output(self, result: Dict) -> str:
        """格式化价格输出"""
        if 'error' in result:
            return f"查询失败：{result['symbol']} - {result['error']}"

        name = result['name']
        symbol = result['symbol']
        price = result['price']
        change = result['change']
        change_percent = result['change_percent']
        volume = result['volume']
        currency = result['currency']
        update_time = result['update_time']

        # 涨跌标记
        change_str = f"+{change}" if change >= 0 else f"{change}"
        change_percent_str = f"+{change_percent}%" if change_percent >= 0 else f"{change_percent}%"

        # 成交量格式化
        if volume >= 1_000_000_000:
            volume_str = f"{volume/1_000_000_000:.2f}B"
        elif volume >= 1_000_000:
            volume_str = f"{volume/1_000_000:.2f}M"
        else:
            volume_str = f"{volume:,}"

        output = f"""
{name} ({symbol})
{'='*50}
实时价格：{price:.2f} {currency}
涨跌：{change_str} ({change_percent_str})
今开：{result['open']:.2f} {currency}
最高：{result['high']:.2f} {currency}
最低：{result['low']:.2f} {currency}
成交量：{volume_str}
更新时间：{update_time}
{'='*50}
"""

        return output


def main():
    """主函数 - 演示用法"""
    fetcher = StockPriceFetcher()

    print("="*60)
    print("股票价格查询工具 v1.0")
    print("="*60)

    # 示例1：查询单只股票
    print("\n【示例1：查询单只股票】")
    result = fetcher.get_stock_price('腾讯')
    print(fetcher.format_price_output(result))

    # 示例2：批量查询
    print("\n【示例2：批量查询多只股票】")
    symbols = ['腾讯', '阿里巴巴', 'AAPL', 'TSLA']
    df = fetcher.get_multiple_stocks(symbols)
    print(df[['symbol', 'name', 'price', 'change', 'change_percent', 'update_time']])

    # 示例3：历史数据
    print("\n【示例3：获取历史数据（最近5天）】")
    hist = fetcher.get_historical_data('0700.HK', '5d')
    if not hist.empty:
        print(hist.tail(5)[['Open', 'Close', 'Change', 'Change_Percent']])


if __name__ == "__main__":
    main()
