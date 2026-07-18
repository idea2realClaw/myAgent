#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
涨停板数据获取脚本 v4
修复问题：
1. 区分科创板/次新股（单独标记）
2. 增加首板/连板识别
3. 增加开盘买入可行性判断（基于昨日收盘vs今日开盘）

功能：
1. 从东方财富API获取涨停股票列表
2. 调用 stock-info 获取每只股票的股本、市值等基本面数据
3. 过滤第一板涨停（排除连板股）
4. 标记科创板/次新股
5. 预测开盘买入可行性
"""

import urllib.request
import urllib.parse
import json
import re
import os
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import sys
import time

# 添加stock-info的路径
STOCK_INFO_PATH = os.path.expanduser('~/.workbuddy/skills/stock-info/scripts')
sys.path.insert(0, STOCK_INFO_PATH)


def get_limit_up_stocks() -> List[Dict]:
    """获取今日涨停股票列表（排除上市首日新股N开头），使用新浪财经API"""
    url = 'http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
    base_params = {
        'num': 100,
        'sort': 'changepercent',
        'asc': 0,  # 降序（涨幅从高到低）
        'node': 'hs_a',  # 沪深A股
        'symbol': '',
        '_s_r_a': 'init'
    }
    
    all_stocks = []
    
    # 获取前5页（500只股票）
    for page in range(1, 6):
        params = dict(base_params, page=page)
        query_string = urllib.parse.urlencode(params)
        full_url = f'{url}?{query_string}'
        
        # 重试3次
        for attempt in range(3):
            try:
                req = urllib.request.Request(full_url, headers={'User-Agent': 'Mozilla/5.0'})
                response = urllib.request.urlopen(req, timeout=30)
                data = response.read().decode('utf-8')
                
                stocks = json.loads(data)
                if stocks:
                    all_stocks.extend(stocks)
                    break  # 成功，跳出重试循环
                else:
                    break  # 没有更多数据
            except Exception as e:
                if attempt < 2:
                    print(f"获取第{page}页第{attempt+1}次失败，重试: {e}")
                    time.sleep(2)
                else:
                    print(f"获取第{page}页最终失败: {e}")
        
        # 如果这一页数据少于100条，说明已经到末页
        if len(all_stocks) >= (page-1)*100 and len(all_stocks) < page*100 and page > 1:
            break
    
    if not all_stocks:
        print("获取涨停数据失败: 所有页面均无数据")
        return []
    
    # 过滤涨停股（涨幅>=9.9%），排除上市首日新股（N开头）
    filtered = [s for s in all_stocks if float(s.get('changepercent', 0)) >= 9.9]
    filtered = [s for s in filtered if not str(s.get('name', '')).startswith('N')]
    
    # 转换成东方财富格式（保持后续代码兼容）
    converted = []
    for s in filtered:
        # 新浪字段 -> 东方财富字段
        code = s.get('code', '')
        # 判断市场：sh=上海，sz=深圳，bj=北京
        symbol = s.get('symbol', '')
        if symbol.startswith('sh'):
            secid = f"1.{code}"
        elif symbol.startswith('sz'):
            secid = f"0.{code}"
        else:
            secid = f"0.{code}"  # 默认深圳
        
        converted.append({
            'f12': code,  # 代码
            'f14': s.get('name', ''),  # 名称
            'f2': float(s.get('trade', 0)),  # 当前价
            'f3': float(s.get('changepercent', 0)),  # 涨幅
            'f5': float(s.get('volume', 0)) * 100,  # 成交量（新浪是手，转成股）
            'f6': float(s.get('amount', 0)),  # 成交额
            'f8': float(s.get('turn_overratio', 0)),  # 换手率
            'f15': float(s.get('high', 0)),  # 最高
            'f16': float(s.get('low', 0)),  # 最低
            'f17': float(s.get('open', 0)),  # 开盘
            'f18': float(s.get('settlement', 0)),  # 昨收
            'f20': float(s.get('mktcap', 0)) * 10000,  # 总市值（新浪是万元，转成元）
            'f21': float(s.get('nmc', 0)) * 10000,  # 流通市值
            'f62': 0,  # 封单金额（新浪API没有，暂设为0）
            'secid': secid,  # 用于后续API查询
        })
    
    return converted


def is_chip_stock(code: str) -> bool:
    """
    判断是否是创业板/科创板/次新股
    
    特征：
    - 30xxxx: 创业板
    - 68xxxx: 科创板
    - 30xxxx/68xxxx 大部分是次新股（上市时间短）
    """
    return code.startswith('30') or code.startswith('68')


def is_new_stock(code: str, days: int = 90) -> bool:
    """
    判断是否是次新股（上市不满days天）
    
    注意：这个功能需要额外API，暂时简化判断
    """
    # 简化：688开头或30开头的股票默认视为次新股
    return is_chip_stock(code)


def get_stock_basic_info(codes: List[str]) -> Dict[str, Dict]:
    """并发获取股票基本面数据（直接使用东方财富API，避免串行超时卡顿）"""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def fetch_single(code: str) -> tuple:
        try:
            if code.startswith('6'):
                secid = f'1.{code}'
            else:
                secid = f'0.{code}'
            url = (f'https://push2.eastmoney.com/api/qt/stock/get?secid={secid}'
                   f'&fields=f57,f58,f84,f85,f116,f167,f173,f176,f177'
                   f'&ut=b2884a393a59ad64002292a3e90d46a5')
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            resp = urllib.request.urlopen(req, timeout=8)
            raw = resp.read().decode('utf-8')
            data = json.loads(raw).get('data', {})
            if data:
                return code, {
                    'code': data.get('f57', code),
                    'name': data.get('f58', ''),
                    'total_shares': data.get('f84', 0),
                    'float_shares': data.get('f85', 0),
                    'total_market_cap': data.get('f116', 0),
                    'pe_ttm': data.get('f176', 0) / 10 if data.get('f176') else None,
                    'pe_dynamic': data.get('f177', 0) / 10 if data.get('f177') else None,
                    'pb': data.get('f167', 0) / 100 if data.get('f167') else None,
                    'dividend_yield': data.get('f173', 0) if data.get('f173') else None,
                }
        except Exception:
            pass
        return code, {}

    results = {}
    max_workers = min(20, len(codes))
    print(f"并发获取 {len(codes)} 只股票基本面（{max_workers} 线程）...")

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(fetch_single, code): code for code in codes}
        done = 0
        for future in as_completed(futures):
            code, info = future.result()
            if info:
                results[code] = info
            done += 1
            if done % 20 == 0:
                print(f"  已完成 {done}/{len(codes)}...")

    print(f"基本面获取完成: {len(results)}/{len(codes)} 只")
    return results


def get_stock_basic_info_backup(codes: List[str]) -> Dict[str, Dict]:
    """备用方案：直接从东方财富API获取股票基本面"""
    results = {}

    for code in codes:
        try:
            if code.startswith('6'):
                secid = f'1.{code}'
            else:
                secid = f'0.{code}'

            url = f'https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f57,f58,f84,f85,f116,f167,f173,f176,f177&ut=b2884a393a59ad64002292a3e90d46a5'

            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            response = urllib.request.urlopen(req, timeout=15)
            raw = response.read().decode('utf-8')

            match = re.search(r'jQuery\((.*)\)', raw)
            if match:
                data = json.loads(match.group(1)).get('data', {})
                if data:
                    results[code] = {
                        'code': data.get('f57', code),
                        'name': data.get('f58', ''),
                        'total_shares': data.get('f84', 0),
                        'float_shares': data.get('f85', 0),
                        'total_market_cap': data.get('f116', 0),
                        'pe_ttm': data.get('f176', 0) / 10 if data.get('f176') else None,
                        'pe_dynamic': data.get('f177', 0) / 10 if data.get('f177') else None,
                        'pb': data.get('f167', 0) / 100 if data.get('f167') else None,
                        'dividend_yield': data.get('f173', 0) if data.get('f173') else None,
                    }

            time.sleep(0.5)

        except Exception as e:
            print(f"获取 {code} 基本信息失败: {e}")

    return results


def get_stock_basic_info_api(codes: List[str]) -> Dict[str, Dict]:
    """通过东方财富API直接获取基本面数据（纯JSON响应）"""
    results = {}

    for code in codes:
        try:
            if code.startswith('6'):
                secid = f'1.{code}'
            else:
                secid = f'0.{code}'

            url = f'https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f57,f58,f84,f85,f116,f167,f173,f176,f177&ut=b2884a393a59ad64002292a3e90d46a5'

            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            response = urllib.request.urlopen(req, timeout=15)
            raw = response.read().decode('utf-8')

            # 直接解析JSON（API返回纯JSON，不是JSONP）
            data = json.loads(raw).get('data', {})
            if data:
                results[code] = {
                    'code': data.get('f57', code),
                    'name': data.get('f58', ''),
                    'total_shares': data.get('f84', 0),
                    'float_shares': data.get('f85', 0),
                    'total_market_cap': data.get('f116', 0),
                    'pe_ttm': data.get('f176', 0) / 10 if data.get('f176') else None,
                    'pe_dynamic': data.get('f177', 0) / 10 if data.get('f177') else None,
                    'pb': data.get('f167', 0) / 100 if data.get('f167') else None,
                    'dividend_yield': data.get('f173', 0) if data.get('f173') else None,
                }

            time.sleep(0.15)

        except Exception as e:
            print(f"获取 {code} 基本信息失败: {e}")

    return results


def filter_first_limit_stocks(stocks: List[Dict], history_file: str) -> List[Dict]:
    """过滤第一板涨停（排除连板股）
    
    策略：优先通过东方财富API获取连续涨停天数，回退到本地历史记录。
    """
    # 优先方案：通过API批量查询连续涨停天数
    first_limit = _filter_by_api_continuous_days(stocks)
    
    if first_limit is not None:
        filtered_count = len(stocks) - len(first_limit)
        print(f"API连板过滤完成: {len(stocks)}只 -> {len(first_limit)}只（过滤{filtered_count}只连板股）")
        return first_limit
    
    # 回退方案：本地历史记录
    history = load_history(history_file)
    today = datetime.now().strftime('%Y-%m-%d')
    last_date = history.get('last_update', '')
    yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
    if not last_date or last_date < yesterday:
        print(f"历史数据过期或为空（最后更新: {last_date}），跳过连板过滤")
        return stocks

    first_limit_stocks = []
    for stock in stocks:
        code = str(stock.get('f12', ''))
        is_continuous = code in history.get('last_limit_date', {})
        if not is_continuous:
            first_limit_stocks.append(stock)

    filtered_count = len(stocks) - len(first_limit_stocks)
    if filtered_count > 0:
        print(f"本地历史连板过滤: {len(stocks)}只 -> {len(first_limit_stocks)}只（过滤{filtered_count}只）")

    return first_limit_stocks


def _filter_by_api_continuous_days(stocks: List[Dict]) -> List[Dict] | None:
    """通过东方财富API获取每只股票的连续涨停天数，过滤连板股（连续>=2天）。
    
    返回:
        List[Dict]: 仅第一板股票列表
        None: API失败，应回退到本地历史
    """
    if not stocks:
        return []
    
    codes = [str(s.get('f12', '')) for s in stocks]
    results = {}
    
    # 并发查询
    from concurrent.futures import ThreadPoolExecutor, as_completed
    max_workers = min(20, len(codes))
    
    def fetch_continuous(code: str):
        try:
            if code.startswith('6'):
                secid = f'1.{code}'
            else:
                secid = f'0.{code}'
            url = (f'https://push2.eastmoney.com/api/qt/stock/get?secid={secid}'
                   f'&fields=f57,f58,f128,f136'
                   f'&ut=b2884a393a59ad64002292a3e90d46a5')
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            resp = urllib.request.urlopen(req, timeout=8)
            raw = resp.read().decode('utf-8')
            data = json.loads(raw).get('data', {})
            if data:
                # f128: 涨停统计（含连续涨停天数），f136: 连板标记
                return code, {
                    'continuous_days': data.get('f128', 0) or 0,
                    'limit_tag': data.get('f136', 0) or 0,
                }
        except Exception:
            pass
        return code, None
    
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(fetch_continuous, code): code for code in codes}
            for future in as_completed(futures, timeout=30):
                code, info = future.result()
                if info is not None:
                    results[code] = info
    except Exception as e:
        print(f"API连板查询失败: {e}")
        return None
    
    if not results:
        print("API连板查询无有效数据")
        return None
    
    success_count = len(results)
    print(f"API连板查询完成: {success_count}/{len(codes)}只")
    
    # 过滤逻辑：连续涨停天数 >= 2 的视为连板
    first_limit = []
    filtered_codes = []
    for stock in stocks:
        code = str(stock.get('f12', ''))
        info = results.get(code)
        if info is None:
            # API查不到的默认保留（宁留勿误删）
            first_limit.append(stock)
        elif info['continuous_days'] >= 2:
            filtered_codes.append(f"{code}({stock.get('f14','')},连{info['continuous_days']}板)")
        else:
            first_limit.append(stock)
    
    if filtered_codes:
        print(f"  过滤连板股: {', '.join(filtered_codes[:10])}"
              + (f"... 等共{len(filtered_codes)}只" if len(filtered_codes) > 10 else ""))
    
    return first_limit


def load_history(filepath: str) -> Dict:
    """加载历史记录"""
    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            return json.load(f)
    return {'stocks': {}, 'last_limit_date': {}}


def save_history(filepath: str, stocks: List[Dict]):
    """保存今日涨停记录"""
    today = datetime.now().strftime('%Y-%m-%d')
    history = load_history(filepath)

    for stock in stocks:
        code = str(stock.get('f12', ''))
        history['stocks'][code] = {
            'name': stock.get('f14', ''),
            'date': today,
            'price': stock.get('f2', 0),
            'change_pct': stock.get('f3', 0),
        }
        history['last_limit_date'][code] = today

    with open(filepath, 'w') as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


def enrich_stock_data(stocks: List[Dict], basic_info: Dict[str, Dict]) -> List[Dict]:
    """合并涨停数据和基本面数据"""
    enriched = []

    for stock in stocks:
        code = str(stock.get('f12', ''))

        # 基础数据
        item = {
            'code': code,
            'name': stock.get('f14', ''),
            'current_price': stock.get('f2', 0),
            'change_pct': stock.get('f3', 0),
            'volume': stock.get('f5', 0),
            'amount': stock.get('f6', 0),
            'turnover': stock.get('f8', 0),
            'sealed_amount': stock.get('f62', 0),
            'high': stock.get('f15', 0),
            'low': stock.get('f16', 0),
            'open': stock.get('f17', 0),      # 今日开盘价
            'prev_close': stock.get('f18', 0), # 昨日收盘价
        }

        # 添加基本面数据
        info = basic_info.get(code, {})
        if info:
            item['total_shares'] = info.get('total_shares', 0)
            item['float_shares'] = info.get('float_shares', 0)
            item['total_market_cap'] = info.get('total_market_cap', 0)
            
            if item['float_shares'] and item['current_price']:
                item['float_market_cap'] = item['current_price'] * item['float_shares']
            else:
                item['float_market_cap'] = 0
                
            item['pe_ttm'] = info.get('pe_ttm')
            item['pe_dynamic'] = info.get('pe_dynamic')
            item['pb'] = info.get('pb')
            item['dividend_yield'] = info.get('dividend_yield')
        else:
            item['total_shares'] = 0
            item['float_shares'] = 0
            item['total_market_cap'] = 0
            item['float_market_cap'] = 0
            item['pe_ttm'] = None
            item['pe_dynamic'] = None
            item['pb'] = None
            item['dividend_yield'] = None

        # 确保数值类型（API可能返回'-'、''等非数字字符串）
        def safe_float(v):
            try:
                return float(v) if v not in (None, '', '-', 'None') else 0
            except (ValueError, TypeError):
                return 0

        item['sealed_amount'] = safe_float(item['sealed_amount'])
        item['float_market_cap'] = safe_float(item['float_market_cap'])
        item['current_price'] = safe_float(item['current_price'])
        item['change_pct'] = safe_float(item['change_pct'])
        item['turnover'] = safe_float(item['turnover'])
        item['prev_close'] = safe_float(item['prev_close'])
        item['open'] = safe_float(item['open'])

        # 计算额外字段
        if item['float_market_cap'] > 0:
            item['sealed_ratio'] = item['sealed_amount'] / item['float_market_cap']
        else:
            item['sealed_ratio'] = 0

        item['float_cap_yi'] = item['float_market_cap'] / 1e8 if item['float_market_cap'] else 0
        
        # 新增：标记科创板/次新股
        item['is_chip'] = is_chip_stock(code)
        
        # 新增：开盘买入可行性分析
        # 昨日收盘 = 今日昨收（prev_close）
        # 今日开盘 = open
        if item['prev_close'] and item['prev_close'] > 0:
            item['open_gap'] = (item['open'] - item['prev_close']) / item['prev_close'] * 100  # 开抢高开幅度%
        else:
            item['open_gap'] = 0
            
        # 可买入判断：
        # - 高开<5%: 可以买入（有溢价空间）
        # - 高开5-10%: 谨慎（溢价较高）
        # - 高开>10%: 不建议（溢价太高）
        # - 平开/低开: 可以买入
        if item['open_gap'] < 5:
            item['can_buy'] = True
            item['buy_advice'] = "可买入"
        elif item['open_gap'] < 10:
            item['can_buy'] = True
            item['buy_advice'] = "谨慎买入"
        else:
            item['can_buy'] = False
            item['buy_advice'] = "不建议"

        enriched.append(item)

    return enriched


def fetch_limit_up_data(first_limit_only: bool = True) -> List[Dict]:
    """获取涨停股票数据（主函数）"""
    print("正在获取涨停股票列表...")

    stocks = get_limit_up_stocks()
    print(f"获取到涨停股票: {len(stocks)} 只")

    if not stocks:
        return []

    codes = [str(s.get('f12', '')) for s in stocks]

    print("正在获取基本面数据...")

    basic_info = get_stock_basic_info(codes)
    
    # 检查基本面数据是否有效（市值是否为0），无效则用API补充
    missing_codes = [c for c in codes if not basic_info.get(c, {}).get('float_shares')]
    if missing_codes:
        print(f"补充获取 {len(missing_codes)} 只股票的基本面数据...")
        api_info = get_stock_basic_info_api(missing_codes)
        basic_info.update(api_info)

    print(f"获取到基本面数据: {len(basic_info)} 只")

    if first_limit_only:
        history_file = os.path.join(os.path.dirname(__file__), 'limit_up_history.json')
        stocks = filter_first_limit_stocks(stocks, history_file)
        print(f"第一板涨停: {len(stocks)} 只")

        save_history(history_file, stocks)

    enriched = enrich_stock_data(stocks, basic_info)

    # 获取概念标签（用于行业赛道评分）
    print("正在获取概念标签...")
    from stock_deep_analysis import fetch_stock_concepts
    from concurrent.futures import ThreadPoolExecutor, as_completed
    enriched_codes = [s['code'] for s in enriched]

    def _fetch_concept(code):
        try:
            concepts = fetch_stock_concepts(code)
            return code, concepts
        except Exception:
            return code, []

    concept_map = {}
    max_workers = min(30, len(enriched_codes))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_fetch_concept, c): c for c in enriched_codes}
        for f in as_completed(futures, timeout=120):
            try:
                code, concepts = f.result()
                if concepts:
                    concept_map[code] = concepts
            except Exception:
                pass

    for s in enriched:
        s['concepts'] = concept_map.get(s['code'], [])

    print(f"概念标签获取完成: {len(concept_map)}/{len(enriched)} 只")

    return enriched


if __name__ == '__main__':
    print("="*60)
    print("涨停板数据获取 v4")
    print("="*60)

    stocks = fetch_limit_up_data(first_limit_only=False)  # 获取所有涨停股

    print(f"\n共获取 {len(stocks)} 只涨停股")

    # 分类显示
    chip_stocks = [s for s in stocks if s.get('is_chip')]
    normal_stocks = [s for s in stocks if not s.get('is_chip')]

    print(f"\n科创板/次新股: {len(chip_stocks)} 只")
    print(f"主板/中小板: {len(normal_stocks)} 只")

    # 显示主板股票
    print("\n主板涨停股（前10只）:")
    print("-"*80)
    for i, s in enumerate(normal_stocks[:10], 1):
        cap = s.get('float_cap_yi', 0)
        cap_str = f"{cap:.1f}亿" if cap > 0 else "N/A"
        sealed = s.get('sealed_amount', 0) / 1e8
        sealed_str = f"{sealed:.2f}亿" if sealed > 0 else "N/A"
        buy_advice = s.get('buy_advice', 'N/A')
        
        print(f"{i:2d}. {s['name']:8s} ({s['code']}) "
              f"涨:{s['change_pct']:+.1f}% 换手:{s['turnover']:.1f}% "
              f"封单:{sealed_str:>8s} 市值:{cap_str:>10s} | {buy_advice}")