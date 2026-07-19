#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实时股票价格查询工具（多源验证）
支持A股、港股、美股实时价格查询，使用多个数据源交叉验证以减少错误
"""

import yfinance as yf
import requests
import pandas as pd
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Union
import json
import time
import csv
import io


class StockPriceFetcher:
    """股票价格获取器"""

    def __init__(self):
        self.market_map = {
            'A股': ['CN', 'SH', 'SZ'],
            '港股': ['HK'],
            '美股': ['US']
        }
        # 价格差异阈值（超过此比例则认为数据可能异常）
        self.price_diff_threshold = 0.02  # 2%
        # 数据新鲜度阈值（秒）
        self.max_data_age = 15 * 60  # 15分钟

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

    def _fetch_stooq_quote(self, symbol: str) -> Optional[Dict]:
        """从Stooq获取报价（适用于美股等）"""
        try:
            # Stooq使用不带市场后缀的代码（如TLT而非TLT.US）
            clean_symbol = symbol
            if '.' in symbol:
                # 移除市场后缀
                base = symbol.split('.')[0]
                # 如果是美股且以SS/SZ/HK结尾，需要特殊处理
                if symbol.endswith(('.SS', '.SZ', '.HK')):
                    # 这些在Stooq可能需要不同格式，暂时跳过
                    return None
                clean_symbol = base

            url = f"https://stooq.com/q/l/?s={clean_symbol}&f=sd2t2ohlcv&h&e=csv"
            response = requests.get(url, timeout=10)
            if response.status_code != 200:
                return None

            # 解析CSV
            content = response.text.strip()
            if not content or 'N/A' in content:
                return None

            # 读取CSV数据
            f = io.StringIO(content)
            reader = csv.DictReader(f)
            row = next(reader, None)
            if not row:
                return None

            # 提取数据
            close_str = row.get('Close', '').strip()
            if not close_str or close_str == 'N/A':
                return None

            try:
                close_price = float(close_str)
            except ValueError:
                return None

            # Stooq通常不提供涨跌额，我们暂时只返回价格
            # 其他字段如开盘、最高、最低、成交量
            open_str = row.get('Open', '0').strip()
            high_str = row.get('High', '0').strip()
            low_str = row.get('Low', '0').strip()
            vol_str = row.get('Volume', '0').strip()

            try:
                open_price = float(open_str) if open_str != 'N/A' else 0.0
                high_price = float(high_str) if high_str != 'N/A' else 0.0
                low_price = float(low_str) if low_str != 'N/A' else 0.0
                volume = int(float(vol_str)) if vol_str not in ('', 'N/A') else 0
            except ValueError:
                open_price = high_price = low_price = 0.0
                volume = 0

            return {
                'price': close_price,
                'open': open_price,
                'high': high_price,
                'low': low_price,
                'volume': volume,
                'source': 'stooq'
            }
        except Exception:
            return None

    def get_stock_price(self, symbol: str) -> Dict:
        """获取单只股票的实时价格（多源验证）"""
        symbol = self.normalize_symbol(symbol)

        # 1. 尝试从Yahoo Finance获取数据
        yf_result = None
        yf_error = None
        try:
            ticker = yf.Ticker(symbol)
            info = ticker.info

            # 获取最新价格
            hist = ticker.history(period='2d', interval='1m')
            if len(hist) > 0:
                latest = hist.iloc[-1]
                current_price = float(latest['Close'])
                open_price = float(latest['Open'])
                high_price = float(latest['High'])
                low_price = float(latest['Low'])
                volume = int(latest['Volume']) if not pd.isna(latest['Volume']) else 0
            else:
                current_price = float(info.get('currentPrice', info.get('regularMarketPrice', 0)))
                open_price = float(info.get('regularMarketOpen', 0))
                high_price = float(info.get('regularMarketDayHigh', 0))
                low_price = float(info.get('regularMarketDayLow', 0))
                volume = int(info.get('regularMarketVolume', 0)) if info.get('regularMarketVolume') else 0

            # 计算涨跌幅
            previous_close = float(info.get('previousClose', current_price))
            change = current_price - previous_close
            change_percent = (change / previous_close * 100) if previous_close != 0 else 0

            # 获取股票名称
            name = info.get('longName', info.get('shortName', symbol))

            yf_result = {
                'symbol': symbol,
                'name': name,
                'price': round(current_price, 2),
                'change': round(change, 2),
                'change_percent': round(change_percent, 2),
                'open': round(open_price, 2),
                'high': round(high_price, 2),
                'low': round(low_price, 2),
                'volume': volume,
                'previous_close': round(previous_close, 2),
                'currency': info.get('currency', 'USD'),
                'update_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                'source': 'yfinance',
                'raw_price': current_price  # 用于比较
            }

            # 检查数据新鲜度（如果可用）
            market_time = info.get('regularMarketTime')
            if market_time:
                try:
                    t_market = datetime.fromtimestamp(market_time)
                    age = (datetime.now() - t_market).total_seconds()
                    if age > self.max_data_age:
                        # 数据可能过期，标记为可能过期
                        yf_result['data_stale'] = True
                    else:
                        yf_result['data_stale'] = False
                except (ValueError, TypeError):
                    yf_result['data_stale'] = False
            else:
                yf_result['data_stale'] = False

        except Exception as e:
            yf_error = str(e)
            yf_result = None

        # 2. 尝试从Stooq获取数据（主要用于美股等）
        stooq_data = None
        # 仅对美股等无后缀或特定后缀的代码尝试Stooq
        if not (symbol.endswith('.SS') or symbol.endswith('.SZ') or symbol.endswith('.HK')):
            stooq_data = self._fetch_stooq_quote(symbol)

        # 3. 数据验证和融合
        final_result = None

        if yf_result is not None:
            # 检查是否需要验证
            needs_validation = False
            validation_reason = []

            # 检查数据新鲜度
            if yf_result.get('data_stale', False):
                needs_validation = True
                validation_reason.append("数据可能过期")

            # 如果有Stooq数据，进行比较
            if stooq_data is not None:
                yf_price = yf_result['raw_price']
                stooq_price = stooq_data['price']
                if yf_price > 0:
                    diff_ratio = abs(yf_price - stooq_price) / yf_price
                    if diff_ratio > self.price_diff_threshold:
                        needs_validation = True
                        validation_reason.append(f"价格差异过大: {diff_ratio:.2%} (Yahoo: {yf_price:.2f}, Stooq: {stooq_price:.2f})")

            if needs_validation:
                # 如果需要验证且有Stooq数据，优先使用Stooq（假设其更及时/准确）
                if stooq_data is not None:
                    # 使用Stooq的价格，但保留Yahoo的其他信息（如名称、货币等）
                    final_result = yf_result.copy()
                    final_result['price'] = round(stooq_data['price'], 2)
                    # 重新计算涨跌变化（基于Stooq价格和昨收）
                    change = final_result['price'] - final_result['previous_close']
                    change_percent = (change / final_result['previous_close'] * 100) if final_result['previous_close'] != 0 else 0
                    final_result['change'] = round(change, 2)
                    final_result['change_percent'] = round(change_percent, 2)
                    final_result['open'] = round(stooq_data['open'], 2)
                    final_result['high'] = round(stooq_data['high'], 2)
                    final_result['low'] = round(stooq_data['low'], 2)
                    final_result['volume'] = stooq_data['volume']
                    final_result['source'] = 'stooq_override'
                    final_result['validation_note'] = "; ".join(validation_reason)
                else:
                    # 没有Stooq数据但需要验证，保留Yahoo数据但添加警告
                    final_result = yf_result
                    final_result['validation_warning'] = "; ".join(validation_reason)
            else:
                # 数据看起来正常
                final_result = yf_result
        else:
            # Yahoo失败，尝试使用Stooq
            if stooq_data is not None:
                # 尝试获取名称和货币信息（可能不完整）
                name = symbol  # 简化处理
                try:
                    ticker = yf.Ticker(symbol)
                    info = ticker.info
                    name = info.get('longName', info.get('shortName', symbol))
                    currency = info.get('currency', 'USD')
                    previous_close = info.get('previousClose', stooq_data['price'])
                except Exception:
                    currency = 'USD'
                    previous_close = stooq_data['price']

                change = stooq_data['price'] - previous_close
                change_percent = (change / previous_close * 100) if previous_close != 0 else 0

                final_result = {
                    'symbol': symbol,
                    'name': name,
                    'price': round(stooq_data['price'], 2),
                    'change': round(change, 2),
                    'change_percent': round(change_percent, 2),
                    'open': round(stooq_data['open'], 2),
                    'high': round(stooq_data['high'], 2),
                    'low': round(stooq_data['low'], 2),
                    'volume': stooq_data['volume'],
                    'previous_close': round(previous_close, 2),
                    'currency': currency,
                    'update_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    'source': 'stooq_fallback',
                    'validation_note': 'Yahoo Finance失败，使用Stooq数据'
                }
            else:
                # 两个来源都失败
                final_result = {
                    'symbol': symbol,
                    'error': f"Yahoo Finance错误: {yf_error}; Stooq未返回数据",
                    'update_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                }

        # 移除内部使用的字段
        if 'raw_price' in final_result:
            del final_result['raw_price']
        if 'data_stale' in final_result:
            del final_result['data_stale']

        return final_result

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

        # 添加验证说明（如果有）
        if 'validation_note' in result:
            output += f"\n※ 数据验证：{result['validation_note']}\n"
        if 'validation_warning' in result:
            output += f"\n⚠ 数据警告：{result['validation_warning']}\n"

        return output


def main():
    """主函数 - 演示用法"""
    fetcher = StockPriceFetcher()

    print("="*60)
    print("股票价格查询工具 v2.0（多源验证）")
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