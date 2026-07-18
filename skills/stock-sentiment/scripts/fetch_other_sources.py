#!/usr/bin/env python3
"""
备用财经数据采集脚本
采集：富途牛牛、同花顺、百度股市通 等平台数据
"""

import requests
import json
import time
import random
import sys
import re
from datetime import datetime, timedelta
from typing import Optional


def get_futu_code(code: str) -> dict:
    """将股票代码转为富途格式"""
    code = code.strip().upper()
    if code.startswith("SH"):
        return {"market": "sh", "code": code[2:], "futu_code": code[2:] + ".SH"}
    elif code.startswith("SZ"):
        return {"market": "sz", "code": code[2:], "futu_code": code[2:] + ".SZ"}

    num = code.replace("SH", "").replace("SZ", "")
    if num.startswith("6"):
        return {"market": "sh", "code": num, "futu_code": num + ".SH"}
    else:
        return {"market": "sz", "code": num, "futu_code": num + ".SZ"}


def fetch_futu_news(stock_code: str, days: int = 90, max_items: int = 100) -> list:
    """
    采集富途牛牛相关股票新闻/快讯
    富途新闻 API 可能需要登录，这里尝试多个端点
    """
    info = get_futu_code(stock_code)
    futu_code = info["futu_code"]
    cutoff_ts = int((datetime.now() - timedelta(days=days)).timestamp())
    items = []

    print(f"[富途] 开始采集 {futu_code} 近{days}天新闻...")

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": "https://www.futunn.com/",
        "Accept": "application/json, */*",
    })

    # 尝试多个富途 API 端点
    apis = [
        ("https://www.futunn.com/quote-api/quote/v2/get-stock-news-v2", {
            "stockCode": futu_code, "market": info["market"].upper(), "type": 0, "begin": 0, "count": 30
        }),
        ("https://www.futunn.com/quote-api/quote/v1/get-stock-news", {
            "stockCode": futu_code, "market": info["market"].upper(), "type": 0, "begin": 0, "count": 30
        }),
    ]

    for url, params in apis:
        try:
            session.get(f"https://www.futunn.com/stock/{futu_code}-stock", timeout=10)
            time.sleep(1)
            resp = session.get(url, params=params, timeout=15)
            data = resp.json()
            news_list = data.get("data", {}).get("newsList", []) if isinstance(data.get("data"), dict) else data.get("data", [])
            if news_list:
                for news in news_list:
                    pub_time = news.get("publicTime", 0) or news.get("time", 0)
                    if pub_time and pub_time < cutoff_ts:
                        return items
                    items.append({
                        "source": "futu_news",
                        "id": news.get("id", ""),
                        "title": news.get("title", ""),
                        "summary": (news.get("summary", "") or news.get("content", "") or "")[:300],
                        "media": news.get("mediaName", "") or "",
                        "created_at": datetime.fromtimestamp(pub_time).strftime("%Y-%m-%d %H:%M") if pub_time else "",
                        "url": news.get("originalUrl", "") or news.get("url", ""),
                        "sentiment": news.get("sentiment", 0),
                    })
                print(f"[富途] 通过 {url.split('/')[-1]} 获取 {len(news_list)} 条新闻")
                return items[:max_items]
        except Exception as e:
            print(f"[富途] API 失败 ({url.split('/')[-1]}): {e}")

    print(f"[富途] ⚠️ 所有富途 API 均不可用（可能需要登录或反爬保护）")
    return items[:max_items]


def fetch_ths_data(stock_code: str, days: int = 90) -> dict:
    """
    采集同花顺人气指数、历史行情
    """
    code = stock_code.strip()
    for prefix in ("SH", "SZ", "BJ"):
        code = code.replace(prefix, "")

    print(f"[同花顺] 采集 {code} 数据...")
    result = {}

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://www.10jqka.com.cn/",
    })

    # 同花顺历史行情数据（可获取近期涨跌）
    try:
        url = f"https://d.10jqka.com.cn/v2/line/hs_{code}/01/last.js"
        resp = session.get(url, timeout=10)
        text = resp.text
        # 格式: quotebridge_v2_line_hs_603798_01_last({...})
        m = re.search(r'\((\{.*\})\)', text)
        if m:
            data = json.loads(m.group(1))
            result["name"] = data.get("name", "")
            result["total"] = data.get("total", "")
            # 取最近几条行情
            daily_data = data.get("data", "").split(";")
            recent_days = []
            for day_str in daily_data[-5:]:
                parts = day_str.split(",")
                if len(parts) >= 3:
                    recent_days.append({
                        "date": parts[0],
                        "close": parts[1],
                        "pct": parts[2] if len(parts) > 2 else "0",
                    })
            result["recent_days"] = recent_days
            print(f"[同花顺] 获取近期行情 {len(recent_days)} 条")
    except Exception as e:
        print(f"[同花顺] 历史行情失败: {e}")

    # 同花顺问股热度
    try:
        url = "https://w.10jqka.com.cn/wen/get_list"
        params = {"code": code, "page": 1, "per_num": 20}
        resp = session.get(url, params=params, timeout=10)
        data = resp.json()
        questions = data.get("data", []) or data.get("list", [])
        result["questions"] = questions[:5] if questions else []
    except Exception:
        pass

    return result


def fetch_baidu_finance(stock_code: str, days: int = 90) -> list:
    """
    采集百度股市通舆情数据
    """
    code = stock_code.strip()
    for prefix in ("SH", "SZ", "BJ"):
        code = code.replace(prefix, "")

    print(f"[百度股市通] 采集 {code} 数据...")
    items = []

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://gushitong.baidu.com/",
    })

    cutoff = datetime.now() - timedelta(days=days)

    # 百度股市通快讯接口
    apis = [
        ("https://gushitong.baidu.com/opendata/app-stockinfo-social", {"query": code, "code": code, "market": "ab"}),
        ("https://gushitong.baidu.com/opendata/app-stockinfo-hotnews", {"query": code, "code": code, "market": "ab"}),
    ]

    for url, params in apis:
        try:
            resp = session.get(url, params=params, timeout=10)
            data = resp.json()
            if data.get("status") == 0 and data.get("data"):
                news_list = data.get("data", []) if isinstance(data.get("data"), list) else data.get("data", {}).get("news", [])
                for item in news_list:
                    pub_time_str = item.get("pubtime", "") or item.get("time", "")
                    try:
                        pub_time = datetime.strptime(pub_time_str[:19], "%Y-%m-%d %H:%M:%S")
                    except Exception:
                        pub_time = datetime.now()
                    if pub_time < cutoff:
                        continue
                    items.append({
                        "source": "baidu_gushitong",
                        "id": item.get("id", ""),
                        "title": item.get("title", "") or "",
                        "text": item.get("abs", "") or item.get("content", "") or item.get("summary", "") or "",
                        "media": item.get("media", "") or "百度股市通",
                        "created_at": pub_time.strftime("%Y-%m-%d %H:%M"),
                        "url": item.get("url", ""),
                    })
                if items:
                    print(f"[百度] 获取 {len(items)} 条")
                    return items
        except Exception as e:
            print(f"[百度] API 失败: {e}")

    print(f"[百度股市通] ⚠️ 无数据或 API 不可用")
    return items


def fetch_cls_news(stock_code: str, days: int = 90, max_items: int = 50) -> list:
    """
    采集财联社快讯（含股票相关新闻）
    财联社网站已全面升级，多个旧 API 已废弃（返回 404）
    尝试多个替代端点
    """
    code = stock_code.strip()
    for prefix in ("SH", "SZ", "BJ"):
        code = code.replace(prefix, "")

    print(f"[财联社] 采集 {code} 相关快讯...")
    items = []

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://www.cls.cn/",
    })

    cutoff = datetime.now() - timedelta(days=days)

    # 尝试多个可能的财联社 API 端点
    apis = [
        ("https://www.cls.cn/nodeapi/telegraphs", {"app": "CLS", "os": "web", "rn": 20, "searchType": "all", "keyword": code}),
        ("https://www.cls.cn/nodeapi/getTelegraph", {"app": "CLS", "os": "web", "rn": 20, "searchType": "all", "keyword": code}),
        ("https://m.cls.cn/api/telegraph", {"app": "CLS", "os": "web", "rn": 20, "keyword": code}),
        # 搜索 API
        ("https://www.cls.cn/nodeapi/search", {"app": "CLS", "os": "web", "rn": 20, "type": "telegraph", "keyword": code}),
    ]

    for url, params in apis:
        try:
            resp = session.get(url, params=params, timeout=15)
            text = resp.text.strip()
            # 只处理 JSON 响应
            if text.startswith("{"):
                data = json.loads(text)
                telegraphs = data.get("data", {}).get("telegram", {}).get("data", []) if isinstance(data.get("data"), dict) else data.get("data", {}).get("data", []) or data.get("data", [])
                if isinstance(telegraphs, list) and telegraphs:
                    for t in telegraphs:
                        if not isinstance(t, dict):
                            continue
                        pub_time_str = t.get("ctime", "") or t.get("create_time", "") or t.get("time", "")
                        try:
                            if isinstance(pub_time_str, (int, float)):
                                pub_time = datetime.fromtimestamp(pub_time_str)
                            else:
                                pub_time = datetime.strptime(str(pub_time_str)[:19], "%Y-%m-%d %H:%M:%S")
                        except Exception:
                            pub_time = datetime.now()
                        if pub_time < cutoff:
                            continue
                        level = t.get("level", 0) or 0
                        content = t.get("content", "") or t.get("text", "") or t.get("summary", "") or ""
                        items.append({
                            "source": "cls_telegraph",
                            "id": t.get("id", ""),
                            "content": str(content)[:400],
                            "level": level,
                            "created_at": pub_time.strftime("%Y-%m-%d %H:%M"),
                            "url": f"https://www.cls.cn/detail/{t.get('id', '')}",
                            "is_breaking": level >= 2,
                        })
                    print(f"[财联社] 通过 {url.split('/')[-1]} 获取 {len(items)} 条")
                    return items[:max_items]
        except Exception as e:
            print(f"[财联社] API 失败 ({url.split('/')[-1]}): {e}")

    print(f"[财联社] ⚠️ 所有 API 均不可用（网站已升级，需要登录或使用新接口）")
    return items[:max_items]


if __name__ == "__main__":
    code = sys.argv[1] if len(sys.argv) > 1 else "603798"

    news = fetch_futu_news(code, days=30, max_items=30)
    print(f"\n富途新闻: {len(news)} 条")

    ths = fetch_ths_data(code, days=90)
    print(f"\n同花顺数据: {json.dumps({k: v for k, v in ths.items() if k != 'questions'}, ensure_ascii=False)}")

    baidu_news = fetch_baidu_finance(code, days=90)
    print(f"\n百度股市通: {len(baidu_news)} 条")

    cls = fetch_cls_news(code, days=30)
    print(f"\n财联社快讯: {len(cls)} 条")
