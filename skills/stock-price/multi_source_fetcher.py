#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
多源实时股票价格查询工具

支持多个数据源交叉验证，提高数据准确性和可靠性
数据源包括：Yahoo Finance、东方财富、新浪财经、雪球等
"""

import requests
from datetime import datetime
from typing import Optional, Dict, List
import time
import json


class MultiSourceStockFetcher:
    """多源股票价格查询器"""

    def __init__(self):
        """初始化查询器"""
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })

    def _parse_yahoo_data(self, symbol: str, response: Dict) -> Optional[Dict]:
        """解析Yahoo Finance返回的数据"""
        try:
            if 'price' in response:
                price = float(response['price'].get('regularMarketPrice', 0))
                change = float(response['price'].get('regularMarketChange', 0))
                change_percent = float(response['price'].get('regularMarketChangePercent', 0))
            else:
                return None

            return {
                'source': 'Yahoo Finance',
                'symbol': symbol,
                'price': price,
                'change': change,
                'change_percent': change_percent,
                'open': float(response['price'].get('regularMarketOpen', 0)),
                'high': float(response['price'].get('regularMarketDayHigh', 0)),
                'low': float(response['price'].get('regularMarketDayLow', 0)),
                'volume': int(response['price'].get('regularMarketVolume', 0)),
                'timestamp': self._format_timestamp(response['price'].get('regularMarketTime')),
                'delay': '15-30分钟'
            }
        except Exception as e:
            print(f"  [Yahoo] 解析失败: {e}")
            return None

    def _parse_eastmoney_data(self, symbol: str, response: Dict) -> Optional[Dict]:
        """解析东方财富返回的数据"""
        try:
            if 'rc' in response and response['rc'] == 0 and 'data' in response:
                data = response['data']
                if 'f43' in data:  # 当前价
                    price = data['f43'] / 100

                change = data.get('f169', 0) / 100
                change_percent = data.get('f170', 0) / 100

                return {
                    'source': '东方财富网',
                    'symbol': symbol,
                    'price': price,
                    'change': change,
                    'change_percent': change_percent,
                    'open': data.get('f46', 0) / 100,
                    'high': data.get('f44', 0) / 100,
                    'low': data.get('f45', 0) / 100,
                    'volume': data.get('f47', 0),
                    'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    'delay': '实时'
                }
        except Exception as e:
            print(f"  [东方财富网] 解析失败: {e}")
            return None

    def _parse_sina_data(self, symbol: str, response: str) -> Optional[Dict]:
        """解析新浪财经返回的数据"""
        try:
            # 格式: var hq_str_sh600519="贵州茅台,1500.00,1505.00,1502.00,..."
            parts = response.split('"')[1].split(',')
            
            if len(parts) >= 32:
                name = parts[0]
                price = float(parts[3])
                prev_close = float(parts[2])
                change = price - prev_close
                change_percent = (change / prev_close * 100) if prev_close > 0 else 0

                return {
                    'source': '新浪财经',
                    'symbol': symbol,
                    'price': price,
                    'change': change,
                    'change_percent': change_percent,
                    'open': float(parts[1]),
                    'high': float(parts[4]),
                    'low': float(parts[5]),
                    'volume': int(parts[8]) * 100,  # 手 -> 股
                    'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    'delay': '实时'
                }
        except Exception as e:
            print(f"  [新浪财经] 解析失败: {e}")
            return None

    def _parse_xueqiu_data(self, symbol: str, response: str) -> Optional[Dict]:
        """解析雪球返回的数据"""
        try:
            data = json.loads(response)
            if 'data' in data and 'quote' in data['data']:
                quote = data['data']['quote']
                current = quote['current']
                prev_close = quote['last_close']
                change = current - prev_close
                change_percent = (change / prev_close * 100) if prev_close > 0 else 0

                return {
                    'source': '雪球',
                    'symbol': symbol,
                    'price': current,
                    'change': change,
                    'change_percent': change_percent,
                    'open': quote['open'],
                    'high': quote['high'],
                    'low': quote['low'],
                    'volume': quote['volume'],
                    'timestamp': datetime.fromtimestamp(quote['time']).strftime('%Y-%m-%d %H:%M:%S'),
                    'delay': '实时'
                }
        except Exception as e:
            print(f"  [雪球] 解析失败: {e}")
            return None

    def _format_timestamp(self, timestamp: Optional[int]) -> str:
        """格式化时间戳"""
        if timestamp:
            return datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
        return datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    def fetch_from_yahoo(self, symbol: str) -> Optional[Dict]:
        """从Yahoo Finance获取数据"""
        print(f"  [Yahoo] 正在查询 {symbol}...")
        try:
            import yfinance as yf
            ticker = yf.Ticker(symbol)
            info = ticker.info

            return self._parse_yahoo_data(symbol, info)
        except ImportError:
            print(f"  [Yahoo] yfinance库未安装，请运行: pip install yfinance")
            return None
        except Exception as e:
            print(f"  [Yahoo] 获取失败: {e}")
            return None

    def fetch_from_eastmoney(self, symbol: str) -> Optional[Dict]:
        """从东方财富网获取数据（支持A股和港股）"""
        print(f"  [东方财富网] 正在查询 {symbol}...")
        try:
            # 解析市场
            if '.' in symbol:
                code, market = symbol.split('.')
                market_map = {'SS': '0', 'SZ': '1', 'HK': '116'}
                market_code = market_map.get(market, '1')
                secid = f"{market_code}.{code}"
            else:
                secid = symbol

            # 东方财富API
            url = "https://push2ex.eastmoney.com/getStockInfo"
            params = {
                'secid': secid,
                'fltt': '2',
                'fields': 'f43,f46,f44,f45,f47,f60,f169,f170',
                'ut': 'fa5fd1943c7b386f172d689fc5a',
                '_': int(time.time() * 1000)
            }

            response = self.session.get(url, params=params, timeout=5)
            data = response.json()

            return self._parse_eastmoney_data(symbol, data)
        except Exception as e:
            print(f"  [东方财富网] 获取失败: {e}")
            return None

    def fetch_from_sina(self, symbol: str) -> Optional[Dict]:
        """从新浪财经获取数据（支持A股和港股）"""
        print(f"  [新浪财经] 正在查询 {symbol}...")
        try:
            # 格式化股票代码
            if '.' in symbol:
                code, market = symbol.split('.')
                if market == 'SS':
                    sina_symbol = f"sh{code}"
                elif market == 'SZ':
                    sina_symbol = f"sz{code}"
                elif market == 'HK':
                    sina_symbol = f"rt_hk{code}"
                else:
                    sina_symbol = symbol
            else:
                # 自动判断
                if symbol.isdigit() and len(symbol) == 6:
                    if symbol.startswith('6'):
                        sina_symbol = f"sh{symbol}"
                    else:
                        sina_symbol = f"sz{symbol}"
                else:
                    sina_symbol = symbol

            # 新浪API
            url = f"http://hq.sinajs.cn/list={sina_symbol}"
            response = self.session.get(url, timeout=5)
            response.encoding = 'GBK'

            if response.text and not '404' in response.text:
                return self._parse_sina_data(symbol, response.text)
        except Exception as e:
            print(f"  [新浪财经] 获取失败: {e}")
            return None

    def fetch_from_xueqiu(self, symbol: str) -> Optional[Dict]:
        """从雪球获取数据（支持A股、港股、美股）"""
        print(f"  [雪球] 正在查询 {symbol}...")
        try:
            # 雪球API
            url = f"https://stock.xueqiu.com/v5/stock/quote.json"
            params = {
                'symbol': symbol,
                'extend': 'detail'
            }

            response = self.session.get(url, params=params, timeout=5)
            data = response.json()

            return self._parse_xueqiu_data(symbol, response.text)
        except Exception as e:
            print(f"  [雪球] 获取失败: {e}")
            return None

    def fetch_multi_source(self, symbol: str) -> List[Dict]:
        """从多个数据源获取股票价格"""
        results = []

        print(f"\n正在获取 {symbol} 的实时价格...")
        print("=" * 70)

        # 从所有数据源获取
        fetchers = [
            ('东方财富网', self.fetch_from_eastmoney),
            ('新浪财经', self.fetch_from_sina),
            ('Yahoo Finance', self.fetch_from_yahoo),
            ('雪球', self.fetch_from_xueqiu),
        ]

        for source_name, fetch_func in fetchers:
            try:
                result = fetch_func(symbol)
                if result:
                    results.append(result)
            except Exception as e:
                print(f"  [{source_name}] 异常: {e}")

        print("=" * 70)

        return results

    def select_best_result(self, results: List[Dict]) -> Optional[Dict]:
        """从多个结果中选择最可靠的一个"""
        if not results:
            return None

        # 优先级: 东方财富网 > 新浪财经 > Yahoo Finance > 雪球
        priority_order = ['东方财富网', '新浪财经', 'Yahoo Finance', '雪球']

        for source_name in priority_order:
            for result in results:
                if result['source'] == source_name:
                    return result

        # 如果没有优先级匹配，返回第一个结果
        return results[0]

    def format_output(self, result: Dict) -> str:
        """格式化输出结果"""
        if not result:
            return "❌ 无法获取股票数据"

        # 涨跌颜色
        if result['change_percent'] > 0:
            trend_emoji = "📈"
            trend_sign = "+"
        elif result['change_percent'] < 0:
            trend_emoji = "📉"
            trend_sign = ""
        else:
            trend_emoji = "➡️"
            trend_sign = ""

        output = f"""
{'=' * 70}
{result['symbol']} ({result['source']})
{'=' * 70}

{trend_emoji} 当前价格: ¥{result['price']:.2f}
   涨跌: {trend_sign}{result['change']:.2f} ({trend_sign}{result['change_percent']:.2f}%)

📊 今日行情:
   开盘: ¥{result['open']:.2f}
   最高: ¥{result['high']:.2f}
   最低: ¥{result['low']:.2f}

📈 交易数据:
   成交量: {result['volume']:,} 股

⏰ 更新时间: {result['timestamp']}
🕐 数据延迟: {result['delay']}

{'=' * 70}
"""
        return output

    def compare_sources(self, symbol: str) -> Dict:
        """交叉验证多个数据源"""
        results = self.fetch_multi_source(symbol)

        if not results:
            return {'status': 'failed', 'message': '所有数据源均无法获取数据'}

        # 选择最可靠的数据源
        best_result = self.select_best_result(results)

        # 统计数据源数量
        source_count = len(results)
        source_names = [r['source'] for r in results]

        # 价格范围
        prices = [r['price'] for r in results]
        price_min = min(prices)
        price_max = max(prices)
        price_avg = sum(prices) / len(prices)
        price_range = price_max - price_min

        return {
            'status': 'success',
            'best_result': best_result,
            'all_results': results,
            'source_count': source_count,
            'source_names': source_names,
            'price_range': {
                'min': price_min,
                'max': price_max,
                'avg': price_avg,
                'range': price_range
            }
        }

    def print_comparison(self, symbol: str) -> None:
        """打印交叉验证结果"""
        comparison = self.compare_sources(symbol)

        if comparison['status'] == 'failed':
            print(comparison['message'])
            return

        print(f"\n✅ 成功获取 {comparison['source_count']} 个数据源")
        print(f"   数据源: {', '.join(comparison['source_names'])}")

        # 显示价格范围
        price_range = comparison['price_range']
        if price_range['range'] > 0:
            print(f"\n📊 价格范围:")
            print(f"   最低: ¥{price_range['min']:.2f}")
            print(f"   最高: ¥{price_range['max']:.2f}")
            print(f"   平均: ¥{price_range['avg']:.2f}")
            print(f"   差异: ¥{price_range['range']:.2f} ({price_range['range']/price_range['avg']*100:.2f}%)")

        # 显示最佳结果
        print(f"\n🎯 推荐使用: {comparison['best_result']['source']}")
        print(self.format_output(comparison['best_result']))


def main():
    """主函数 - 演示用法"""
    print("=" * 70)
    print("多源实时股票价格查询工具")
    print("=" * 70)
    print(f"当前时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    fetcher = MultiSourceStockFetcher()

    # 示例：查询云天化和小米
    print("\n【示例1：查询云天化(600096.SH)】")
    fetcher.print_comparison('600096.SH')

    print("\n" + "=" * 70 + "\n")

    print("【示例2：查询小米(1810.HK)】")
    fetcher.print_comparison('1810.HK')

    print("\n" + "=" * 70)
    print("使用说明:")
    print("  fetcher.print_comparison('600096.SS')  # A股")
    print("  fetcher.print_comparison('1810.HK')     # 港股")
    print("  fetcher.print_comparison('AAPL')        # 美股")
    print("=" * 70)


if __name__ == '__main__':
    main()
