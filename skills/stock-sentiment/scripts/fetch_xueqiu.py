#!/usr/bin/env python3
"""
雪球 + 备用行情数据采集脚本
雪球：股票关注人数、讨论帖（需要登录 cookie）
备用：东方财富实时行情、新浪财经行情
"""

import requests
import json
import time
import random
import sys
import os
import re
from datetime import datetime, timedelta
from typing import Optional

COOKIES_FILE = os.path.expanduser("~/ClawData/WorkBuddy/cookies.json")

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Referer": "https://xueqiu.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def get_stock_symbol(code: str) -> str:
    """转换股票代码为雪球格式"""
    code = code.strip()
    if code.startswith(("SH", "SZ", "HK")):
        return code.upper()
    if code.startswith("6"):
        return f"SH{code}"
    elif code.startswith(("0", "3")):
        return f"SZ{code}"
    elif code.startswith(("688", "689")):
        return f"SH{code}"
    return code


def load_xueqiu_cookies() -> dict:
    """加载雪球 cookies"""
    if os.path.exists(COOKIES_FILE):
        try:
            with open(COOKIES_FILE, "r") as f:
                data = json.load(f)
            if isinstance(data, list):
                return {c["name"]: c["value"] for c in data if "xueqiu" in c.get("domain", "")}
            return data
        except Exception:
            pass
    return {}


def fetch_xueqiu_discuss_v2(session: requests.Session, symbol: str, days: int = 90, max_posts: int = 200) -> list:
    """
    雪球讨论帖采集（v2：尝试多个 API 端点）
    """
    cutoff_ts = int((datetime.now() - timedelta(days=days)).timestamp() * 1000)
    posts = []
    page = 1

    # 尝试多个雪球 API 端点
    api_endpoints = [
        ("https://stock.xueqiu.com/v5/stock/f10/social/discuss.json", {"symbol": symbol, "count": 20, "page": page, "type": 11, "source": "all"}),
    ]

    # 先尝试不需要 token 的雪球社区 API（可能可用）
    try:
        url = "https://xueqiu.com/v4/statuses/public_timeline_by_category.json"
        params = {"category": symbol, "count": 20, "page": page}
        resp = session.get(url, params=params, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            items = data.get("list", [])
            if items:
                print(f"[雪球] 社区API成功，采集 {len(items)} 条")
                # 处理数据...
    except Exception:
        pass

    # 主要 API（需要 cookie）
    while len(posts) < max_posts:
        url = "https://stock.xueqiu.com/v5/stock/f10/social/discuss.json"
        params = {
            "symbol": symbol,
            "count": 20,
            "page": page,
            "type": 11,
            "source": "all",
        }

        try:
            resp = session.get(url, params=params, timeout=15)
            if resp.status_code == 400:
                error = resp.json()
                if error.get("error_code") == "400016":
                    print("[雪球] ⚠️ 需要登录，Cookie 失效或过期（error 400016）")
                    break
            if resp.status_code != 200:
                print(f"[雪球] 请求失败 HTTP {resp.status_code}")
                break

            data = resp.json()
            items = data.get("data", {}).get("list", [])
            if not items:
                break

            for item in items:
                created_at = item.get("created_at", 0)
                if created_at < cutoff_ts:
                    return posts

                posts.append({
                    "source": "xueqiu",
                    "id": item.get("id"),
                    "title": item.get("title", ""),
                    "text": item.get("text", "")[:500],
                    "user": (item.get("user") or {}).get("screen_name", ""),
                    "followers": (item.get("user") or {}).get("followers_count", 0),
                    "like_count": item.get("like_count", 0),
                    "reply_count": item.get("reply_count", 0),
                    "retweet_count": item.get("retweet_count", 0),
                    "created_at": datetime.fromtimestamp(created_at / 1000).strftime("%Y-%m-%d %H:%M"),
                    "url": f"https://xueqiu.com/{(item.get('user') or {}).get('id', '')}/{item.get('id', '')}",
                })

            print(f"[雪球] 第{page}页，已采集 {len(posts)} 条")
            page += 1
            time.sleep(random.uniform(0.8, 1.5))

        except Exception as e:
            print(f"[雪球] 采集异常: {e}")
            break

    return posts[:max_posts]


def fetch_xueqiu_info(stock_code: str) -> dict:
    """
    获取股票行情信息（优先东方财富，备用新浪财经）
    返回：名称、代码、当前价、涨跌幅、市盈率、市值、关注人数
    """
    # 方法1：东方财富（最可靠）
    result = _fetch_eastmoney_quote(stock_code)
    if result:
        return result

    # 方法2：新浪财经
    result = _fetch_sina_quote(stock_code)
    if result:
        return result

    return {}


def _fetch_eastmoney_quote(stock_code: str) -> Optional[dict]:
    """东方财富行情 API（最可靠）"""
    code = stock_code.strip().upper().replace("SH", "").replace("SZ", "")
    # 判断市场
    if code.startswith("6") or code.startswith(("688", "689")):
        market = "1"
    else:
        market = "0"
    secid = f"{market}.{code}"

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://quote.eastmoney.com/",
    })

    try:
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get"
        params = {
            "fltt": 2, "invt": 2,
            # 常用字段：行情 + 估值 + 市值
            "fields": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f19,f20,f21,f22,f23,f24,f25,f26,f62,f115",
            "secids": secid,
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        }
        resp = session.get(url, params=params, timeout=10)
        text = resp.text.strip()

        # 同时支持 JSONP 和纯 JSON 格式
        data = {}
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            # 尝试 JSONP 格式：jQuery({...})
            m = re.search(r'\(\s*(\{.*\})\s*\)', text, re.DOTALL)
            if m:
                data = json.loads(m.group(1))

        diff = data.get("data", {}).get("diff", [])
        if diff:
            d = diff[0]
            return {
                "name": d.get("f14", ""),
                "symbol": d.get("f12", ""),
                "current": d.get("f2", 0),
                "percent": d.get("f3", 0),
                "price_change": d.get("f4", 0),
                "volume": d.get("f5", 0),
                "amount": d.get("f6", 0),
                "turnover": d.get("f8", 0),
                "pe": d.get("f9", "-"),
                "pe_g": d.get("f10", "-"),
                "market_cap": d.get("f20", 0),
                "float_market_cap": d.get("f21", 0),
                "high": d.get("f15", 0),
                "low": d.get("f16", 0),
                "open": d.get("f17", 0),
                "prev_close": d.get("f18", 0),
                "pb": d.get("f23", "-"),
                "52w_high": d.get("f24", 0),
                "52w_low": d.get("f25", 0),
                "listing_date": d.get("f26", ""),
                "xueqiu_followers": 0,
            }
    except Exception as e:
        print(f"[行情] 东方财富失败: {e}")
    return None


def _fetch_sina_quote(stock_code: str) -> Optional[dict]:
    """新浪财经行情（备用）"""
    code = stock_code.strip().lower().replace("sh", "").replace("sz", "")
    if code.startswith("6"):
        symbol = f"sh{code}"
    else:
        symbol = f"sz{code}"

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://finance.sina.com.cn/",
    })

    try:
        resp = session.get(f"https://hq.sinajs.cn/list={symbol}", timeout=10)
        text = resp.text
        # var hq_str_sh603798="康普顿,0.000,15.620,..."
        # 字段索引：0=名称,1=开盘,2=昨收,3=当前,4=最高,5=最低,8=成交量,9=成交额,30=日期,31=时间
        # 基本面：38=PE, 39=PB(ttm), 46=总市值
        m = re.search(r'="([^"]+)"', text)
        if m:
            fields = m.group(1).split(",")
            if len(fields) > 10:
                name = fields[0]
                prev_close = float(fields[2]) if fields[2] else 0
                current = float(fields[3]) if fields[3] else 0
                open_price = float(fields[1]) if fields[1] else 0
                high = float(fields[4]) if fields[4] else 0
                low = float(fields[5]) if fields[5] else 0
                volume = float(fields[8]) if fields[8] else 0  # 股数
                amount = float(fields[9]) if fields[9] else 0  # 金额
                date = fields[30] if len(fields) > 30 else ""
                time_str = fields[31] if len(fields) > 31 else ""

                # PE（字段38）、PB（字段39）
                pe = float(fields[38]) if len(fields) > 38 and fields[38] else "-"
                pb = float(fields[39]) if len(fields) > 39 and fields[39] else "-"

                # 计算涨跌幅：停牌时 fields[3]=0，用昨收作为参考价
                if prev_close:
                    if current == 0:  # 停牌，取昨收作为参考价
                        ref_price = prev_close
                        pct = 0.0
                    else:
                        ref_price = prev_close
                        pct = round((current - prev_close) / prev_close * 100, 2)
                else:
                    ref_price = current
                    pct = 0.0

                return {
                    "name": name,
                    "symbol": code,
                    "current": current if current > 0 else prev_close,  # 停牌时显示昨收
                    "percent": pct,
                    "price_change": round(current - prev_close, 2) if current > 0 else 0.0,
                    "open": open_price,
                    "high": high,
                    "low": low,
                    "volume": volume,
                    "amount": amount,
                    "pe": pe,
                    "pb": pb,
                    "date": date,
                    "time": time_str,
                    "xueqiu_followers": 0,
                }
    except Exception as e:
        print(f"[行情] 新浪财经失败: {e}")
    return None


def fetch_xueqiu_posts(stock_code: str, days: int = 90, max_posts: int = 200) -> list:
    """对外接口：采集雪球讨论帖"""
    symbol = get_stock_symbol(stock_code)
    cookies = load_xueqiu_cookies()

    session = requests.Session()
    session.headers.update(BASE_HEADERS)
    if cookies:
        session.cookies.update(cookies)
    else:
        try:
            session.get("https://xueqiu.com/", timeout=10)
            time.sleep(1)
        except Exception:
            pass

    print(f"[雪球] 开始采集 {symbol} 近{days}天讨论...")
    posts = fetch_xueqiu_discuss_v2(session, symbol, days, max_posts)
    return posts


def fetch_xueqiu_stock_info(stock_code: str) -> dict:
    """对外接口：获取股票行情信息（不需要登录）"""
    print(f"[行情] 获取 {stock_code} 行情信息...")
    return fetch_xueqiu_info(stock_code)


if __name__ == "__main__":
    code = sys.argv[1] if len(sys.argv) > 1 else "603798"
    info = fetch_xueqiu_info(code)
    print(f"行情信息: {json.dumps(info, ensure_ascii=False, indent=2)}")
    print()
    posts = fetch_xueqiu_posts(code, days=30, max_posts=20)
    print(f"\n共采集 {len(posts)} 条雪球讨论")
    if posts:
        for p in posts[:3]:
            print(f"\n  [{p['created_at']}] {p['user']}（粉丝{p['followers']}）")
            print(f"  👍{p['like_count']} 💬{p['reply_count']}")
            print(f"  {p['text'][:100]}...")
