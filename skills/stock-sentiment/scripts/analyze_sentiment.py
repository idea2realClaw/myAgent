#!/usr/bin/env python3
"""
股民情绪分析模块
基于关键词和规则对帖子/新闻进行情绪评分，无需外部 NLP 库
"""

import re
from collections import Counter
from typing import List, Dict

# ───────────────── 情绪关键词字典 ─────────────────

BULLISH_STRONG = [
    "大涨", "暴涨", "涨停", "强势", "突破", "新高", "主力进场", "抄底良机",
    "超预期", "业绩爆炸", "重大利好", "绝对低估", "强烈推荐", "满仓", "加仓",
    "回购", "增持", "大股东增持", "回购完成", "定增", "并购重组", "重大合同",
    "扭亏为盈", "净利润大增", "收入创新高", "龙头", "王者", "翻倍",
]

BULLISH_WEAK = [
    "看好", "值得关注", "有机会", "向上", "支撑", "底部", "反弹", "企稳",
    "利好", "上涨", "看多", "乐观", "低估", "便宜", "性价比", "调整到位",
    "买入", "跟进", "关注", "布局", "埋伏", "积累筹码",
]

BEARISH_STRONG = [
    "大跌", "暴跌", "跌停", "崩盘", "爆雷", "暴雷", "退市风险", "立案调查",
    "重大亏损", "净利润暴跌", "业绩变脸", "减持套现", "大股东减持", "清仓",
    "资金链断裂", "财务造假", "违规", "处罚", "停牌核查", "连续跌停",
    "亏损扩大", "血亏", "割肉", "斩仓",
]

BEARISH_WEAK = [
    "看空", "谨慎", "风险", "压力", "套牢", "解套难", "下跌", "跌", "空头",
    "悲观", "高估", "泡沫", "止损", "回调", "压力位", "减仓", "逃跑",
    "不建议", "远离", "回避",
]

# 重要信息关键词
IMPORTANT_KEYWORDS = {
    "公司治理": ["实际控制人", "董事长", "CEO", "高管", "股权变更", "控股权"],
    "资本运作": ["定增", "配股", "回购", "并购", "重组", "分拆", "借壳"],
    "业绩相关": ["净利润", "营业收入", "毛利率", "业绩预告", "业绩快报", "年报", "季报"],
    "监管风险": ["立案", "调查", "处罚", "违规", "ST", "*ST", "退市"],
    "股东动向": ["增持", "减持", "质押", "解质押", "大宗交易"],
    "产品合同": ["中标", "签约", "合同", "订单", "新产品", "专利", "许可证"],
}

# 情绪强度权重
EMOTION_WEIGHTS = {
    "bullish_strong": +3,
    "bullish_weak": +1,
    "bearish_strong": -3,
    "bearish_weak": -1,
}


def score_text(text: str) -> Dict:
    """
    对单条文本进行情绪评分
    返回：{score, category, matched_keywords, important_info}
    """
    text_lower = text.lower()
    score = 0
    matched = []
    
    for word in BULLISH_STRONG:
        if word in text:
            score += EMOTION_WEIGHTS["bullish_strong"]
            matched.append((word, "bullish_strong"))
    
    for word in BULLISH_WEAK:
        if word in text:
            score += EMOTION_WEIGHTS["bullish_weak"]
            matched.append((word, "bullish_weak"))
    
    for word in BEARISH_STRONG:
        if word in text:
            score += EMOTION_WEIGHTS["bearish_strong"]
            matched.append((word, "bearish_strong"))
    
    for word in BEARISH_WEAK:
        if word in text:
            score += EMOTION_WEIGHTS["bearish_weak"]
            matched.append((word, "bearish_weak"))
    
    # 重要信息检测
    important_info = []
    for category, keywords in IMPORTANT_KEYWORDS.items():
        hits = [kw for kw in keywords if kw in text]
        if hits:
            important_info.append({"category": category, "keywords": hits})
    
    # 情绪分类
    if score >= 4:
        category = "强烈看多"
    elif score >= 2:
        category = "看多"
    elif score >= 1:
        category = "偏多"
    elif score <= -4:
        category = "强烈看空"
    elif score <= -2:
        category = "看空"
    elif score <= -1:
        category = "偏空"
    else:
        category = "中性"
    
    return {
        "score": score,
        "category": category,
        "matched_keywords": matched[:5],  # 最多显示5个
        "important_info": important_info,
    }


def analyze_posts(posts: List[Dict]) -> Dict:
    """
    批量分析帖子情绪，返回统计摘要
    """
    if not posts:
        return {}
    
    scores = []
    categories = []
    all_keywords = []
    important_posts = []
    hot_posts = []
    
    for post in posts:
        text = f"{post.get('title', '')} {post.get('text', '')}"
        result = score_text(text)
        
        post["sentiment_score"] = result["score"]
        post["sentiment_category"] = result["category"]
        post["important_info"] = result["important_info"]
        
        scores.append(result["score"])
        categories.append(result["category"])
        all_keywords.extend([kw for kw, _ in result["matched_keywords"]])
        
        if result["important_info"]:
            important_posts.append(post)
        
        # 热帖判断：互动量高
        interaction = post.get("like_count", 0) + post.get("reply_count", 0) * 2 + post.get("retweet_count", 0)
        if interaction > 0:
            post["_interaction"] = interaction
            hot_posts.append(post)
    
    # 统计
    avg_score = sum(scores) / len(scores) if scores else 0
    cat_counter = Counter(categories)
    kw_counter = Counter(all_keywords)
    
    bullish_count = sum(cat_counter.get(c, 0) for c in ["强烈看多", "看多", "偏多"])
    bearish_count = sum(cat_counter.get(c, 0) for c in ["强烈看空", "看空", "偏空"])
    neutral_count = cat_counter.get("中性", 0)
    total = len(posts)
    
    # 整体情绪判断
    if avg_score >= 2:
        overall = "🔴 强烈看多"
    elif avg_score >= 0.5:
        overall = "🟠 偏多"
    elif avg_score >= -0.5:
        overall = "⚪ 中性"
    elif avg_score >= -2:
        overall = "🟢 偏空"
    else:
        overall = "🟢 强烈看空"
    
    # 热帖排序
    hot_posts.sort(key=lambda x: x.get("_interaction", 0), reverse=True)
    
    return {
        "total_posts": total,
        "avg_score": round(avg_score, 2),
        "overall_sentiment": overall,
        "distribution": {
            "bullish": bullish_count,
            "neutral": neutral_count,
            "bearish": bearish_count,
            "bullish_pct": f"{bullish_count/total*100:.1f}%" if total else "0%",
            "bearish_pct": f"{bearish_count/total*100:.1f}%" if total else "0%",
        },
        "top_keywords": kw_counter.most_common(10),
        "hot_posts": hot_posts[:10],
        "important_posts": important_posts[:20],
        "posts": posts,
    }


def analyze_announcements(announcements: List[Dict]) -> Dict:
    """分析公告中的重要信息"""
    if not announcements:
        return {}
    
    important = [a for a in announcements if a.get("is_important")]
    by_type = Counter(a.get("type", "其他") for a in announcements)
    
    return {
        "total": len(announcements),
        "important_count": len(important),
        "by_type": dict(by_type.most_common(10)),
        "important_list": important[:15],
    }


def analyze_research_reports(reports: List[Dict]) -> Dict:
    """分析研报评级分布"""
    if not reports:
        return {}
    
    ratings = Counter(r.get("rating", "未知") for r in reports)
    
    # 评级情绪分
    rating_score = {
        "买入": 3, "强烈推荐": 3, "强推": 3,
        "增持": 2, "推荐": 2, "优于大市": 2,
        "中性": 0, "持有": 0, "与大市同步": 0,
        "减持": -2, "低于大市": -2,
        "卖出": -3, "回避": -3,
    }
    
    total_score = 0
    scored = 0
    for r in reports:
        rating = r.get("rating", "")
        for key, val in rating_score.items():
            if key in rating:
                total_score += val
                scored += 1
                break
    
    avg = total_score / scored if scored else 0
    
    return {
        "total": len(reports),
        "rating_distribution": dict(ratings.most_common()),
        "avg_rating_score": round(avg, 2),
        "institution_count": len(set(r.get("org", "") for r in reports)),
        "latest_reports": reports[:10],
    }


if __name__ == "__main__":
    # 测试
    test_posts = [
        {"title": "中油工程利好来了！大涨可期", "text": "主力进场信号明显，强烈推荐买入"},
        {"title": "谨慎，风险较大", "text": "大股东减持，资金面压力，建议减仓"},
        {"title": "公司发布年报，净利润大增30%", "text": "业绩超预期，看好后续表现"},
        {"title": "随便聊聊", "text": "今天市场平淡，观望为主"},
    ]
    result = analyze_posts(test_posts)
    print(f"整体情绪: {result['overall_sentiment']}")
    print(f"看多/中性/看空: {result['distribution']}")
    print(f"高频词: {result['top_keywords']}")
