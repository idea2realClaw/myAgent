#!/usr/bin/env python3
"""
东方财富数据采集脚本
采集：股吧讨论、公告、研报摘要
"""

import requests
import json
import time
import random
import sys
import re
from datetime import datetime, timedelta
from typing import Optional, List

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Referer": "https://guba.eastmoney.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def get_eastmoney_code(code: str) -> tuple[str, str]:
    """
    返回 (市场代码, 股票代码)
    东财格式：SH=1, SZ=0, BJ=0
    """
    code = code.strip().upper()
    for prefix in ("SH", "SZ", "BJ"):
        if code.startswith(prefix):
            market = "1" if prefix == "SH" else "0"
            return market, code[2:]

    num = code
    if num.startswith("6") or num.startswith(("688", "689")):
        return "1", num
    elif num.startswith(("0", "3")):
        return "0", num
    elif num.startswith(("4", "8")):
        return "0", num
    return "1", num


def fetch_guba_posts(stock_code: str, days: int = 90, max_posts: int = 200) -> list:
    """
    采集东方财富股吧讨论
    优先使用 Playwright 采集（SPA 页面，无 JSON API）
    """
    code = stock_code.strip()
    for prefix in ("SH", "SZ", "BJ"):
        code = code.replace(prefix, "")
    posts = []

    print(f"[股吧] 开始采集 {code} 近{days}天讨论（Playwright SPA模式）...")

    # 方法1：Playwright（SPA 页面，需要动态渲染）
    try:
        posts = _fetch_guba_playwright(code, max_posts=max_posts)
        if posts:
            print(f"[股吧] Playwright 成功获取 {len(posts)} 条")
            return posts
    except Exception as e:
        print(f"[股吧] Playwright 采集失败: {e}")

    # 方法2-4：API 备用方案
    cutoff = datetime.now() - timedelta(days=days)
    session = requests.Session()
    session.headers.update(BASE_HEADERS)

    fetched = _fetch_guba_news(session, code, cutoff, posts, max_posts)
    if fetched > 0:
        print(f"[股吧] 通过东财资讯获取 {fetched} 条")
        return posts

    fetched = _fetch_guba_kuaixun(session, code, cutoff, posts, max_posts)
    if fetched > 0:
        print(f"[股吧] 通过东财快讯获取 {fetched} 条")
        return posts

    fetched = _fetch_guba_f10(session, code, cutoff, posts, max_posts)
    if fetched > 0:
        print(f"[股吧] 通过东财F10获取 {fetched} 条")
        return posts

    print(f"[股吧] ⚠️ 东财股吧所有数据源不可用")
    return posts


def _fetch_guba_playwright(code: str, max_posts: int = 200) -> list:
    """
    Playwright 采集东财股吧（SPA 页面，需要动态渲染）
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return []

    posts = []
    seen_ids = set()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_default_timeout(30000)

            for sort_type in ("f", "p"):
                if len(posts) >= max_posts:
                    break

                # 访问股吧页面
                page.goto(f"https://guba.eastmoney.com/list,{code},{sort_type}.html", timeout=30000)
                import time as _time
                _time.sleep(5)

                # 滚动加载更多
                for _ in range(5):
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    _time.sleep(1.5)

                # 翻多页
                for page_num in range(2, 8):
                    if len(posts) >= max_posts:
                        break
                    try:
                        page.goto(f"https://guba.eastmoney.com/list,{code},{sort_type}_{page_num}.html", timeout=30000)
                        _time.sleep(3)
                        for _ in range(3):
                            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                            _time.sleep(1)
                    except Exception:
                        break

                # 提取帖子链接
                links = page.query_selector_all(f"a[href*='/news,{code},']")
                for link in links:
                    if len(posts) >= max_posts:
                        break
                    href = link.get_attribute("href") or ""
                    if not href or href in seen_ids:
                        continue

                    ts_match = re.search(r'/news,\w+,(\d+)\.html', href)
                    title = link.inner_text().strip()
                    if not title or len(title) < 5:
                        continue

                    seen_ids.add(href)
                    ts = int(ts_match.group(1)) if ts_match else 0
                    post_time = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else ""

                    posts.append({
                        "source": "eastmoney_guba",
                        "id": ts_match.group(1) if ts_match else href.split(",")[-1].replace(".html", ""),
                        "title": title,
                        "text": "",
                        "user": "",
                        "like_count": 0,
                        "reply_count": 0,
                        "read_count": 0,
                        "created_at": post_time,
                        "url": f"https://guba.eastmoney.com{href}",
                    })

            browser.close()
    except Exception as e:
        print(f"[Playwright] 股吧采集异常: {e}")

    return posts


def _fetch_guba_news(session, code: str, cutoff, posts: list, max_posts: int) -> int:
    """东财个股资讯 API"""
    try:
        url = "https://np-listwap.eastmoney.com/api/sll/getList"
        params = {
            "client": "web",
            "ids": f"1,{code}",
            "page": 1,
            "count": 20,
            "type": 1,
            "_": int(time.time()),
        }
        resp = session.get(url, params=params, timeout=10)
        text = resp.text.strip()
        if text.startswith("{") or text.startswith("["):
            data = json.loads(text)
            items = data if isinstance(data, list) else data.get("data", [])
            for item in items:
                title = item.get("title", "") or item.get("t", "")
                content = item.get("summary", "") or item.get("s", "") or item.get("content", "") or ""
                pub_time_str = item.get("ptime", "") or item.get("time", "") or item.get("showtime", "")
                if not pub_time_str:
                    continue
                try:
                    pub_time = datetime.fromisoformat(pub_time_str.replace("/", "-"))
                except Exception:
                    try:
                        pub_time = datetime.strptime(pub_time_str, "%Y-%m-%d %H:%M:%S")
                    except Exception:
                        pub_time = datetime.now()
                if pub_time < cutoff:
                    continue
                posts.append({
                    "source": "eastmoney_news",
                    "id": item.get("id", ""),
                    "title": title[:200],
                    "text": content[:500],
                    "user": item.get("source", "") or "东方财富",
                    "like_count": item.get("like_count", 0) or item.get("supportCount", 0),
                    "reply_count": item.get("comment_count", 0) or item.get("replyCount", 0) or 0,
                    "read_count": item.get("read_count", 0) or 0,
                    "created_at": pub_time.strftime("%Y-%m-%d %H:%M"),
                    "url": item.get("url", "") or item.get("art_url", ""),
                })
            return len(posts)
    except Exception as e:
        print(f"[股吧] 东财资讯 API 失败: {e}")
    return 0


def _fetch_guba_kuaixun(session, code: str, cutoff, posts: list, max_posts: int) -> int:
    """东财快讯 API（个股相关）"""
    try:
        url = "https://np-listwap.eastmoney.com/api/sll/getList_ajax"
        params = {
            "client": "web",
            "ids": f"1,{code}",
            "page": 1,
            "count": 20,
            "type": 1,
        }
        resp = session.get(url, params=params, timeout=10)
        text = resp.text.strip()
        if text.startswith("{"):
            data = json.loads(text)
            items = data.get("data", []) or data.get("list", [])
            for item in items:
                content = item.get("content", "") or item.get("s", "") or ""
                pub_time_str = item.get("showtime", "") or item.get("time", "")
                if not content:
                    continue
                try:
                    pub_time = datetime.strptime(pub_time_str[:19], "%Y-%m-%d %H:%M:%S")
                except Exception:
                    pub_time = datetime.now()
                if pub_time < cutoff:
                    continue
                posts.append({
                    "source": "eastmoney_kuaixun",
                    "id": item.get("id", ""),
                    "title": content[:80],
                    "text": content[:500],
                    "user": "东方财富快讯",
                    "like_count": 0,
                    "reply_count": 0,
                    "read_count": 0,
                    "created_at": pub_time.strftime("%Y-%m-%d %H:%M"),
                    "url": item.get("url", ""),
                })
            return len(posts)
    except Exception as e:
        print(f"[股吧] 东财快讯 API 失败: {e}")
    return 0


def _fetch_guba_f10(session, code: str, cutoff, posts: list, max_posts: int) -> int:
    """东财 F10 舆情"""
    try:
        url = "https://emweb.securities.eastmoney.com/PC_HSF10/Social/Content"
        params = {
            "parm": code,
            "page": 1,
            "pageSize": 20,
            "sort": 1,  # 按时间排序
        }
        resp = session.get(url, params=params, timeout=10)
        text = resp.text.strip()
        if text.startswith("{") or text.startswith("["):
            data = json.loads(text)
            items = data if isinstance(data, list) else data.get("data", []) or data.get("list", [])
            for item in items:
                pub_time_str = item.get("createTime", "") or item.get("postTime", "") or ""
                try:
                    pub_time = datetime.strptime(pub_time_str[:19], "%Y-%m-%d %H:%M:%S")
                except Exception:
                    pub_time = datetime.now()
                if pub_time < cutoff:
                    continue
                posts.append({
                    "source": "eastmoney_f10",
                    "id": item.get("id", ""),
                    "title": item.get("title", "") or "",
                    "text": item.get("content", "") or item.get("text", "") or "",
                    "user": item.get("userName", "") or item.get("nickname", "") or "东财用户",
                    "like_count": item.get("likeCount", 0),
                    "reply_count": item.get("replyCount", 0),
                    "created_at": pub_time.strftime("%Y-%m-%d %H:%M"),
                    "url": item.get("url", "") or f"https://emweb.securities.eastmoney.com/PC_HSF10/pages/index.html?type=web&code={code}",
                })
            return len(posts)
    except Exception as e:
        print(f"[股吧] 东财F10 API 失败: {e}")
    return 0


def fetch_announcements(stock_code: str, days: int = 90) -> list:
    """
    采集东方财富上市公司公告
    """
    market, code = get_eastmoney_code(stock_code)
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    announcements = []

    print(f"[公告] 开始采集 {code} 近{days}天公告...")

    url = "https://np-anotice-stock.eastmoney.com/api/security/ann"
    params = {
        "sr": -1,
        "page_size": 100,
        "page_index": 1,
        "ann_type": "ALL",
        "client_source": "web",
        "stock_list": f"{market},{code}",
        "start_time": cutoff,
        "end_time": datetime.now().strftime("%Y-%m-%d"),
        "fields": "art_name,notice_date,notice_type,art_url",
    }

    try:
        session = requests.Session()
        session.headers.update({
            **BASE_HEADERS,
            "Referer": f"https://data.eastmoney.com/notices/stock/{code}.html",
        })
        resp = session.get(url, params=params, timeout=15)
        data = resp.json()
        items = data.get("data", {}).get("list", [])
        if not items:
            total = data.get("data", {}).get("total_hits", 0)
            print(f"[公告] API正常，但近{days}天共 {total} 条公告")

        for item in items:
            notice_type = str(item.get("notice_type", ""))
            notice_date = item.get("notice_date", "")[:10] if item.get("notice_date") else ""
            title = item.get("art_name", "")
            announcements.append({
                "source": "eastmoney_ann",
                "title": title,
                "type": notice_type,
                "date": notice_date,
                "url": item.get("art_url", ""),
                "is_important": any(kw in title for kw in [
                    "重大", "业绩", "增持", "减持", "回购", "并购", "收购",
                    "定增", "配股", "年报", "半年报", "季报", "股东大会",
                    "立案", "处罚", "整改", "停产", "重组", "风险", "退市"
                ]),
            })

        print(f"[公告] 获取 {len(announcements)} 条公告")
    except Exception as e:
        print(f"[公告] 采集失败: {e}")

    return announcements


def fetch_research_reports(stock_code: str, days: int = 90) -> list:
    """
    采集东方财富研报摘要
    """
    market, code = get_eastmoney_code(stock_code)

    print(f"[研报] 开始采集 {code} 近{days}天研报...")
    reports = []

    url = "https://reportapi.eastmoney.com/report/list"
    params = {
        "industryCode": "*",
        "pageSize": 50,
        "industry": "*",
        "rating": "*",
        "ratingChange": "*",
        "beginTime": (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d"),
        "endTime": datetime.now().strftime("%Y-%m-%d"),
        "pageNo": 1,
        "fields": "infoCode,searchCode,category,title,orgSName,rating,ratingChange,publishDate,indvIncomeC,indvIncomeRate,epsTcnt,gainsToGrt,pE,pB,marketCap,summary",
        "qType": 0,
        "orgCode": "",
        "code": f"{market},{code}",
    }

    try:
        session = requests.Session()
        session.headers.update({**BASE_HEADERS, "Referer": "https://data.eastmoney.com/report/"})
        resp = session.get(url, params=params, timeout=15)
        data = resp.json()

        # 安全解析：data 可能为空 dict 或 None
        raw_data = data.get("data")
        if raw_data is None:
            raw_data = {}
        items = raw_data if isinstance(raw_data, list) else raw_data.get("list", [])
        if not items:
            hits = data.get("hits", 0)
            print(f"[研报] API正常，但近{days}天共 {hits} 条研报（可能无机构覆盖）")

        for item in items:
            if not isinstance(item, dict):
                continue
            rating = item.get("rating", "") or ""
            reports.append({
                "source": "eastmoney_report",
                "title": item.get("title", ""),
                "org": item.get("orgSName", ""),
                "rating": rating,
                "target_price": item.get("targetPrice", "") or "",
                "date": item.get("publishDate", "")[:10] if item.get("publishDate") else "",
                "url": item.get("reportLink", "") or "",
                "summary": (item.get("summary", "") or "")[:300],
                "is_important": any(kw in rating for kw in ["买入", "增持", "强烈", "推荐"]) if rating else False,
            })

        print(f"[研报] 获取 {len(reports)} 条研报")
    except Exception as e:
        print(f"[研报] 采集失败: {e}")

    return reports


if __name__ == "__main__":
    code = sys.argv[1] if len(sys.argv) > 1 else "603798"
    posts = fetch_guba_posts(code, days=30, max_posts=30)
    print(f"\n共采集 {len(posts)} 条股吧讨论")
    for p in posts[:3]:
        print(f"  [{p['created_at']}] {p.get('title', p.get('text',''))[:50]}")

    anns = fetch_announcements(code, days=90)
    print(f"\n共采集 {len(anns)} 条公告")
    for a in anns[:3]:
        print(f"  [{a['date']}] {a['title']}")

    reports = fetch_research_reports(code, days=90)
    print(f"\n共采集 {len(reports)} 条研报")
    for r in reports[:3]:
        print(f"  [{r['date']}] {r['org']} - {r['rating']} - {r['title'][:50]}")
