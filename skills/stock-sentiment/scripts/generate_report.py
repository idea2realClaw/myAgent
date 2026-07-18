#!/usr/bin/env python3
"""
股票舆情分析报告生成器
整合多源数据，生成综合舆情 Markdown 报告
"""

import sys
import os
import json
import time
from datetime import datetime

# 添加脚本目录到路径
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# 导入各采集模块
sys.path.insert(0, SCRIPT_DIR)

try:
    from fetch_xueqiu import fetch_xueqiu_info, fetch_xueqiu_posts
    from fetch_eastmoney import fetch_guba_posts, fetch_announcements, fetch_research_reports
    from fetch_other_sources import fetch_futu_news, fetch_ths_data, fetch_baidu_finance, fetch_cls_news
except ImportError as e:
    print(f"[错误] 导入模块失败: {e}")
    print("请确保所有 fetch_*.py 文件存在")
    sys.exit(1)


def analyze_sentiment(posts: list) -> dict:
    """
    基于关键词分析舆情情绪
    返回：情绪分布、高频词、重要信息
    """
    if not posts:
        return {"bullish": 0, "neutral": 0, "bearish": 0, "total": 0, "score": 0, "keywords": []}

    bullish_keywords = [
        "买入", "做多", "加仓", "满仓", "涨停", "突破", "新高", "强势",
        "推荐", "增持", "低估", "价值", "成长", "看涨", "机会", "布局",
        "反弹", "回暖", "复苏", "超跌", "绩优", "龙头", "暴拉", "大牛"
    ]
    bearish_keywords = [
        "卖出", "止损", "减仓", "清仓", "跌停", "破位", "新低", "弱势",
        "减持", "高估", "风险", "看空", "回避", "暴雷", "亏损", "造假",
        "减持", "骗局", "泡沫", "崩盘", "割肉", "踩雷", "暴仓"
    ]

    bullish_count = 0
    bearish_count = 0
    all_text = ""

    for post in posts:
        text = (post.get("title", "") + " " + post.get("text", "")).lower()
        all_text += text + " "
        for kw in bullish_keywords:
            if kw in text:
                bullish_count += 1
                break
        for kw in bearish_keywords:
            if kw in text:
                bearish_count += 1
                break

    neutral_count = max(0, len(posts) - bullish_count - bearish_count)

    # 情绪评分：满分100，正面>负面 → 偏多
    if len(posts) > 0:
        sentiment_ratio = (bullish_count - bearish_count) / len(posts)
        score = 50 + sentiment_ratio * 50
        score = max(0, min(100, score))
    else:
        score = 50

    # 高频词提取
    import re
    words = re.findall(r'[\u4e00-\u9fa5]{2,5}', all_text)
    stopwords = set(["这个", "那个", "可以", "就是", "因为", "所以", "但是", "已经", "应该", "可能", "今天", "现在", "一个", "什么", "怎么", "没有", "大家", "自己", "感觉", "觉得", "股票", "股市", "市场", "公司", "目前", "之后", "之前", "一下", "这种", "还是", "如果", "的话"])
    words = [w for w in words if w not in stopwords and len(w) >= 2]
    freq = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1
    top_keywords = sorted(freq.items(), key=lambda x: x[1], reverse=True)[:15]
    top_keywords = [f"{kw}({cnt}次)" for kw, cnt in top_keywords]

    return {
        "bullish": bullish_count,
        "neutral": neutral_count,
        "bearish": bearish_count,
        "total": len(posts),
        "score": round(score, 1),
        "keywords": top_keywords,
    }


def check_important_info(posts: list) -> list:
    """检测重要信息：业绩、增减持、监管等"""
    important_keywords = {
        "业绩": ["业绩", "净利润", "营收", "利润", "增长", "下滑", "亏损", "盈利", "EPS"],
        "增减持": ["增持", "减持", "回购", "大宗", "股权转让", "定增", "配股"],
        "监管": ["证监会", "监管", "立案", "处罚", "整改", "问询函", "警示函"],
        "重大事项": ["并购", "收购", "重组", "分拆", "上市", "退市", "摘帽", "ST"],
        "分红": ["分红", "送股", "转增", "股息", "派息"],
    }

    important_posts = []
    for post in posts:
        text = (post.get("title", "") + " " + post.get("text", ""))
        for category, keywords in important_keywords.items():
            for kw in keywords:
                if kw in text:
                    important_posts.append({
                        "source": post.get("source", ""),
                        "title": post.get("title", "") or post.get("text", "")[:80],
                        "category": category,
                        "keyword": kw,
                        "date": post.get("created_at", ""),
                        "url": post.get("url", ""),
                        "like_count": post.get("like_count", 0),
                    })
                    break
    return important_posts


def generate_report(stock_code: str, days: int = 90, output_dir: str = None) -> str:
    """
    生成舆情分析报告

    Args:
        stock_code: 股票代码（如 603798 或 SH603798）
        days: 回溯天数
        output_dir: 输出目录，默认 ~/ClawData/WorkBuddy/

    Returns:
        报告文件路径
    """
    stock_code = stock_code.strip().upper()
    for prefix in ("SH", "SZ"):
        stock_code = stock_code.replace(prefix, "")

    if output_dir is None:
        output_dir = os.path.expanduser("~/ClawData/WorkBuddy/")
    os.makedirs(output_dir, exist_ok=True)

    today = datetime.now().strftime("%Y-%m-%d")
    output_file = os.path.join(output_dir, f"sentiment-{stock_code}-{today}.md")

    print(f"\n{'='*60}")
    print(f"开始分析 {stock_code} 近{days}天舆情")
    print(f"{'='*60}\n")

    all_posts = []  # 所有平台的帖子
    stock_info = {}

    # 1. 股票基本信息
    print("【1/6】获取股票基础信息...")
    stock_info = fetch_xueqiu_info(stock_code)
    if stock_info:
        name = stock_info.get("name", stock_code)
        print(f"  股票：{name} ({stock_code})")
        print(f"  当前价：{stock_info.get('current', '-')}（{'🔴+' if stock_info.get('percent', 0) >= 0 else '🟢'}{stock_info.get('percent', '-')}%）")
    else:
        name = stock_code
    print()

    # 2. 雪球讨论
    print("【2/6】采集雪球讨论...")
    try:
        xueqiu_posts = fetch_xueqiu_posts(stock_code, days=days, max_posts=200)
        all_posts.extend(xueqiu_posts)
        print(f"  雪球：{len(xueqiu_posts)} 条讨论\n")
    except Exception as e:
        print(f"  雪球采集失败: {e}\n")

    # 3. 东方财富股吧
    print("【3/6】采集东方财富股吧...")
    try:
        guba_posts = fetch_guba_posts(stock_code, days=days, max_posts=200)
        all_posts.extend(guba_posts)
        print(f"  股吧：{len(guba_posts)} 条帖子\n")
    except Exception as e:
        print(f"  股吧采集失败: {e}\n")

    # 4. 公告和研报
    print("【4/6】采集公告和研报...")
    announcements = []
    reports = []
    try:
        announcements = fetch_announcements(stock_code, days=days)
    except Exception as e:
        print(f"  公告采集失败: {e}")
    try:
        reports = fetch_research_reports(stock_code, days=days)
    except Exception as e:
        print(f"  研报采集失败: {e}")
    print()

    # 5. 其他平台
    print("【5/6】采集其他平台（富途/百度/财联社）...")
    futu_news = fetch_futu_news(stock_code, days=days)
    all_posts.extend(futu_news)
    baidu_news = fetch_baidu_finance(stock_code, days=days)
    all_posts.extend(baidu_news)
    cls_news = fetch_cls_news(stock_code, days=days)
    all_posts.extend(cls_news)
    ths_data = fetch_ths_data(stock_code, days=days)
    print()

    # 6. 情绪分析
    print("【6/6】进行情绪分析...")
    sentiment = analyze_sentiment(all_posts)
    important = check_important_info(all_posts)
    print(f"  总讨论：{sentiment['total']} 条")
    print(f"  情绪评分：{sentiment['score']} 分\n")

    # ===== 生成报告 =====
    print(f"正在生成报告...")

    # 帖子时间范围检测
    post_dates = []
    for p in all_posts:
        dt_str = p.get("created_at", "")
        if dt_str and len(dt_str) >= 10:
            try:
                post_dates.append(datetime.strptime(dt_str[:10], "%Y-%m-%d"))
            except Exception:
                pass

    if post_dates:
        newest_post = max(post_dates)
        oldest_post = min(post_dates)
        days_ago = (datetime.now() - newest_post).days
        post_date_range = f"{oldest_post.strftime('%Y-%m-%d')} ~ {newest_post.strftime('%Y-%m-%d')}"
        if days_ago > 30:
            data_warning = f"⚠️ **数据时效提示**：帖子最新时间为 {newest_post.strftime('%Y-%m-%d')}（距今 {days_ago} 天前），非近期数据，请谨慎参考。"
            heat_note = "（⚠️历史数据）"
        else:
            data_warning = ""
            heat_note = ""
    else:
        post_date_range = "暂无数据"
        data_warning = ""
        heat_note = ""
        newest_post = datetime.now()  # 默认值，避免后续引用错误

    # 热度评级（根据实际讨论量，不区分时间）
    total_posts = sentiment["total"]
    if total_posts >= 100:
        heat_level = "🔥🔥🔥 极高"
    elif total_posts >= 50:
        heat_level = "🔥🔥 较高"
    elif total_posts >= 20:
        heat_level = "🔥 一般"
    elif total_posts >= 5:
        heat_level = "❄️ 较低"
    else:
        heat_level = "❄️❄️ 极低"

    # 情绪标签
    if sentiment["score"] >= 70:
        sentiment_label = "偏多 📈"
    elif sentiment["score"] >= 40:
        sentiment_label = "中性 📊"
    else:
        sentiment_label = "偏空 📉"

    # 格式化行情数据
    def _fmt(val, suffix=""):
        if val is None or val == "" or val == "-":
            return "-"
        try:
            v = float(val)
            if v == 0:
                return "-"
            return f"{v:.2f}{suffix}"
        except (TypeError, ValueError):
            return str(val) if val else "-"

    pct_val = stock_info.get("percent", 0)
    try:
        pct_display = f"{pct_val:+.2f}%" if pct_val else "-"
    except (TypeError, ValueError):
        pct_display = "-"

    # 市值格式化
    mktcap = stock_info.get("market_cap", 0)
    floatcap = stock_info.get("float_market_cap", 0)
    mktcap_str = _fmt_market_cap(mktcap) if mktcap else "-"
    floatcap_str = _fmt_market_cap(floatcap) if floatcap else "-"

    # 按来源统计
    source_stats = {}
    for p in all_posts:
        src = p.get("source", "unknown")
        source_stats[src] = source_stats.get(src, 0) + 1

    report = f"""# {name}（{stock_code}）舆情分析报告

**分析周期**：{(datetime.now() - __import__('datetime').timedelta(days=days)).strftime('%Y-%m-%d')} ~ {today}（近{days}天）
**生成时间**：{today} {datetime.now().strftime('%H:%M:%S')}
**数据来源**：雪球、东方财富、百度股市通、富途牛牛、财联社

---

## 一、人气概况

| 指标 | 数值 |
|------|------|
| 股票名称 | {name}（{stock_code}） |
| 当前价格 | {_fmt(stock_info.get('current'))} 元 |
| 涨跌幅 | {'🔴 ' if (pct_val or 0) >= 0 else '🟢 '}{pct_display} |
| 市盈率(PE) | {stock_info.get('pe', '-') or '-'} |
| 市净率(PB) | {stock_info.get('pb', '-') or '-'} |
| 总市值 | {mktcap_str} |
| 流通市值 | {floatcap_str} |
| **近{days}天总讨论量** | **{total_posts} 条** |
| **讨论热度** | **{heat_level}{heat_note}** |

"""

    if data_warning:
        report += f"> {data_warning}\n\n"

    report += f"""### 各平台数据统计

| 数据源 | 帖子数量 |
|--------|---------|
"""

    for src, count in sorted(source_stats.items(), key=lambda x: x[1], reverse=True):
        src_name = {"xueqiu": "雪球", "eastmoney_guba": "东财股吧", "eastmoney_news": "东财资讯",
                    "eastmoney_kuaixun": "东财快讯", "eastmoney_f10": "东财F10",
                    "futu_news": "富途新闻", "baidu_gushitong": "百度股市通",
                    "cls_telegraph": "财联社快讯"}.get(src, src)
        report += f"| {src_name} | {count} 条 |\n"

    if post_dates:
        report += f"\n> 📅 **帖子时间范围**：{post_date_range}（{len(post_dates)} 条有日期帖子）\n"

    # 同花顺近期行情
    if ths_data.get("recent_days"):
        report += f"\n### 同花顺近期行情\n\n| 日期 | 收盘价 | 涨跌幅 |\n|------|--------|--------|\n"
        for day in ths_data["recent_days"]:
            pct = float(day.get("pct", 0) or 0)
            report += f"| {day.get('date', '')} | {day.get('close', '-')} | {'🔴' if pct >= 0 else '🟢'} {pct:+.2f}% |\n"

    report += f"""
---

## 二、市场情绪分析

| 情绪维度 | 数量 |
|----------|------|
| 看多（买入/加仓/推荐等） | {sentiment['bullish']} 条 |
| 中性 | {sentiment['neutral']} 条 |
| 看空（卖出/减仓/风险等） | {sentiment['bearish']} 条 |

**综合情绪评分**：**{sentiment['score']} 分**（{sentiment_label}）

"""
    if sentiment["total"] == 0:
        report += f"> ⚠️ 近{days}天各平台暂无讨论数据，可能原因：\n"
        report += "> 1. 股票关注度较低（小盘股/冷门股）\n"
        report += "> 2. 部分平台需要登录才能访问数据\n"
        report += "> 3. 数据接口临时不可用\n\n"
    else:
        if sentiment["keywords"]:
            report += f"**高频话题**：{' | '.join(sentiment['keywords'][:10])}\n\n"

    # 热帖精选
    report += """---

## 三、热帖精选（互动量最高）

"""
    hot_posts = sorted(all_posts, key=lambda x: (x.get("like_count", 0) or 0) + (x.get("reply_count", 0) or 0) * 2, reverse=True)[:10]
    if hot_posts:
        for i, post in enumerate(hot_posts, 1):
            src_name = {"xueqiu": "雪球", "eastmoney_guba": "东财股吧", "eastmoney_news": "东财资讯",
                        "eastmoney_kuaixun": "东财快讯", "eastmoney_f10": "东财F10",
                        "futu_news": "富途新闻", "baidu_gushitong": "百度股市通",
                        "cls_telegraph": "财联社快讯"}.get(post.get("source", ""), post.get("source", ""))
            title = post.get("title", "") or post.get("text", "")[:80]
            report += f"**{i}. {title}**\n"
            report += f"   - 来源：{src_name} | 日期：{post.get('created_at', '-')} | 👍{post.get('like_count', 0)} 💬{post.get('reply_count', 0)}\n"
            if post.get("url"):
                report += f"   - 链接：{post.get('url', '')}\n"
            report += "\n"
    else:
        report += "> 暂无热帖数据\n\n"

    # 重要信息
    report += """---

## 四、重要信息提示

"""
    if important:
        important_cats = {}
        for item in important:
            cat = item["category"]
            if cat not in important_cats:
                important_cats[cat] = []
            important_cats[cat].append(item)

        for cat, items in important_cats.items():
            report += f"### {cat}（{len(items)} 条）\n\n"
            for item in items[:5]:
                title = item["title"][:80]
                report += f"- [{title}]({item['url']}) — {item['date']} 【{item['keyword']}】\n"
            report += "\n"
    else:
        report += "> 未检测到明显重要信息（业绩、增减持、监管等关键词）\n\n"

    # 公司公告
    report += """---

## 五、近期公司公告

"""
    important_anns = [a for a in announcements if a.get("is_important")]
    normal_anns = [a for a in announcements if not a.get("is_important")]

    if announcements:
        if important_anns:
            report += f"### 重要公告（{len(important_anns)} 条）\n\n"
            for a in important_anns[:10]:
                report += f"- **【{a.get('type', '')}】{a['title']}** — {a['date']}\n"
            report += "\n"
        if normal_anns:
            report += f"### 一般公告（{len(normal_anns)} 条）\n\n"
            for a in normal_anns[:10]:
                report += f"- {a['title']} — {a['date']}\n"
        if len(normal_anns) > 10:
            report += f"- ... 还有 {len(normal_anns) - 10} 条\n"
    else:
        report += "> 近期无公告（可能无重大事项，或接口暂时无法获取）\n"
        report += f"> 💡 提示：可通过东财官网手动查看 https://data.eastmoney.com/notices/stock/{stock_code}.html\n\n"

    # 机构研报
    report += """---

## 六、机构研报

"""
    if reports:
        # 评级统计
        rating_stats = {}
        for r in reports:
            rating = r.get("rating", "未知") or "未知"
            rating_stats[rating] = rating_stats.get(rating, 0) + 1

        report += f"### 研报概况（共 {len(reports)} 条）\n\n"
        report += "| 评级 | 数量 |\n|------|------|\n"
        for rating, count in sorted(rating_stats.items(), key=lambda x: x[1], reverse=True):
            emoji = "🟢" if "买入" in rating or "增持" in rating else ("🔴" if "减持" in rating or "卖出" in rating else "⚪")
            report += f"| {emoji} {rating} | {count} |\n"
        report += "\n"

        report += "### 最新研报\n\n"
        for r in reports[:5]:
            summary = r.get("summary", "")[:150]
            report += f"**{r['date']} {r.get('org', '')}** — {r.get('rating', '')}\n"
            report += f"- {r['title']}\n"
            if summary:
                report += f"- 摘要：{summary}...\n"
            if r.get("url"):
                report += f"- [查看原文]({r['url']})\n"
            report += "\n"
    else:
        report += "> 近期无机构研报（可能原因：\n"
        report += "> 1. 该股票无分析师覆盖（中小盘股常见）\n"
        report += f"> 2. 近{days}天无新发布研报）\n\n"

    # 财联社快讯
    if cls_news:
        report += """---

## 七、财联社重要快讯

"""
        breaking = [n for n in cls_news if n.get("is_breaking")]
        normal = [n for n in cls_news if not n.get("is_breaking")]
        if breaking:
            report += f"### 重要快讯（{len(breaking)} 条）\n\n"
            for n in breaking[:5]:
                report += f"🚨 **{n['content'][:200]}**\n- {n['created_at']}  [{n['source']}]({n['url']})\n\n"
        if normal:
            report += f"### 普通快讯（{len(normal)} 条）\n\n"
            for n in normal[:5]:
                report += f"- {n['content'][:120]} — {n['created_at']}\n"

    # 数据时效性判断
    data_recency_days = (datetime.now() - newest_post).days if post_dates else 999
    
    # 综合评估
    report += """---

## 八、综合评估

"""
    report += f"| 评估维度 | 结论 | 说明 |\n|--------|------|------|\n"
    if data_recency_days <= 30:
        heat_label = "较高" if total_posts >= 50 else ("一般" if total_posts >= 10 else "偏低")
        heat_note = f"近{days}天共{total_posts}条讨论"
    else:
        heat_label = "⚠️ 低关注"
        heat_note = f"近期无讨论（{total_posts}条为历史数据）"
    report += f"| 市场人气 | {heat_label} | {heat_note} |\n"
    report += f"| 市场情绪 | {sentiment_label} | 评分 {sentiment['score']}/100 |\n"

    if reports:
        top_rating = max(reports, key=lambda r: r.get("rating", ""))
        report += f"| 机构态度 | {'偏正面' if any('买入' in r.get('rating','') for r in reports) else '待观察'} | {len(reports)}家机构发布研报 |\n"
    else:
        report += f"| 机构态度 | ⚠️ 无覆盖 | 无机构发布研报 |\n"

    if important_anns:
        report += f"| 重要公告 | ✅ 有 | {len(important_anns)}条重要公告 |\n"
    else:
        report += f"| 重要公告 | 正常 | 近{days}天无重大公告 |\n"

    if announcements:
        report += f"| 公告数量 | {len(announcements)}条 | 运营正常 |\n"
    else:
        report += f"| 公告频率 | 较低 | 近期无公告 |\n"

    data_complete = "✅ 良好" if (data_recency_days <= 30 and total_posts >= 20) else ("⚠️ 部分" if (data_recency_days <= 90 and total_posts >= 5) else "❌ 偏少")
    complete_note = "正常" if data_recency_days <= 30 else f"⚠️ 数据为{newest_post.strftime('%Y-%m-%d')}历史数据"
    report += f"| 数据完整性 | {data_complete} | {complete_note} |\n"

    # 总结
    report += "\n### 综合总结\n\n"

    if sentiment["score"] >= 65 and total_posts >= 20:
        report += f"> 📈 **偏多信号**：{name}近期市场情绪偏正面（{sentiment_label}），人气较活跃（{total_posts}条讨论），{'机构评级偏正面' if reports and any('买入' in r.get('rating','') for r in reports) else '暂无机构评级可参考'}。"
    elif sentiment["score"] <= 40 and total_posts >= 20:
        report += f"> 📉 **偏空信号**：{name}近期市场情绪偏负面（{sentiment_label}），需关注风险。机构{'中性偏谨慎' if reports else '暂无覆盖'}。"
    elif total_posts < 5:
        report += f"> ❄️ **关注度较低**：{name}近{days}天各平台讨论量较少（{total_posts}条），属于小众股票，市场关注度不高。{'基本面无明显异动' if not important_anns else '建议关注近期重要公告。'}"
    elif data_recency_days > 30:
        report += f"> ⚠️ **历史数据仅供参考**：{name}近{days}天各平台暂无新讨论（最新帖{newest_post.strftime('%Y-%m-%d')}），属于低关注度股票。历史舆情{sentiment_label}（评分{sentiment['score']}），**当前无近期数据，请关注基本面和公告。**"
    else:
        report += f"> 📊 **中性整理**：{name}近期市场情绪中性，人气一般，暂无明显方向性信号。"

    report += f"""

> 💡 **使用提示**：
> - 本报告基于公开信息自动采集，数据来源包括雪球、东方财富、富途、财联社等
> - 情绪分析基于关键词匹配，可能存在误判，仅供参考
> - 部分平台（雪球等）需要登录才能获取完整数据，未登录时讨论量可能偏少
> - 建议结合基本面分析（PE、业绩、行业）综合判断

---

> ⚠️ 本报告基于公开信息自动采集分析，仅供参考，不构成投资建议。股市有风险，入市需谨慎。

*报告生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*
"""

    # 写入文件
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\n✅ 报告已保存至: {output_file}")
    return output_file


def _fmt_market_cap(cap) -> str:
    """格式化市值"""
    try:
        cap = float(cap)
        if cap >= 1e8:  # 亿元
            return f"{cap / 1e8:.2f} 亿元"
        elif cap >= 1e4:  # 万元
            return f"{cap / 1e4:.2f} 万元"
        else:
            return f"{cap:.0f} 元"
    except (TypeError, ValueError):
        return "-"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 generate_report.py <股票代码> [天数]")
        print("示例: python3 generate_report.py 603798 90")
        sys.exit(1)

    code = sys.argv[1]
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 90

    report_file = generate_report(code, days=days)
    print(f"\n报告路径: {report_file}")
