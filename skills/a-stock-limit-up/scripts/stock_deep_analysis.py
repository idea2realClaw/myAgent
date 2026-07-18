#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
涨停TOP10深度分析脚本

对涨停评分排名前10的股票进行深度分析：
1. 基本面分析（PE、PB、ROE、营收、净利润等）
2. 涨停原因分析（基于行业、概念、资金面）
3. 概念板块获取（多数据源方案）
4. 综合建议
"""

import json
import time
import urllib.request
import urllib.parse
from typing import List, Dict, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed


def _safe_divide(value, divisor):
    """
    安全除法，对ROE等字段做合理性检查。
    东方财富API字段单位不统一，需要检测：
    - 如果值本身已经是百分比级（如 5.4 表示5.4%），直接返回
    - 如果值是万分比（如 540），需要除以100得到5.4%
    - 如果值是更大的数（如 54000），需要除以10000得到5.4%
    """
    if value is None:
        return None
    abs_val = abs(value)
    if abs_val == 0:
        return 0
    # 合理百分比范围：-100% ~ 200%
    if abs_val <= 200:
        return value  # 已经是百分比
    elif abs_val <= 20000:
        return value / divisor  # 万分比级别
    else:
        return value / (divisor * 100)  # 更大单位


def _parse_roe(raw_value):
    """
    解析ROE字段（f183）。

    东方财富API的f183字段单位极不稳定：
    - 有的股票返回正常百分比（如 5.4）
    - 有的返回万分比级别（如 540）
    - 有的返回更大值（如 5406533649）

    策略：如果原始值 > 1000，认为数据异常，跳过。
    """
    if raw_value is None:
        return None
    abs_val = abs(raw_value)
    if abs_val <= 200:
        return raw_value
    elif abs_val <= 20000:
        return raw_value / 100
    elif abs_val <= 100000:
        return raw_value / 10000
    else:
        # 数值异常大（如5406533649），API返回了无意义的数据
        # 尝试从其他字段推导：ROE ≈ PB / PE × 100（仅当PE>0时有效）
        return None  # 标记为数据不可用


# ==================== 财务数据获取 ====================

def fetch_financial_data(code: str) -> Dict:
    """获取股票财务数据（最新财报）"""
    try:
        if code.startswith('6'):
            secid = f'1.{code}'
        else:
            secid = f'0.{code}'

        # 东方财富财务摘要API
        url = (f'https://push2.eastmoney.com/api/qt/stock/get?secid={secid}'
               f'&fields=f57,f58,f84,f85,f116,f162,f163,f164,f167,f168,f169,'
               f'f170,f171,f173,f176,f177,f183,f184,f185,f186,f187,f188'
               f'&ut=b2884a393a59ad64002292a3e90d46a5')
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode('utf-8')).get('data', {})
        if not data:
            return {}

        return {
            'code': data.get('f57', code),
            'name': data.get('f58', ''),
            'total_shares': data.get('f84', 0),
            'float_shares': data.get('f85', 0),
            'total_market_cap': data.get('f116', 0),
            # 东方财富API字段单位说明：
            # f162 EPS: 原始值/100 = 元
            # f163 BPS: 原始值/100 = 元
            # f167 PB: 原始值/100（如101 → 1.01）
            # f173 股息率: 已经是百分比（如0.22 → 0.22%）
            # f176 PE_TTM: 已经是整数PE值（如75 → 75倍）
            # f177 PE动态: 已经是整数PE值
            # f183 ROE: 单位万分比×100，需要/10000（但有时是正常百分比）
            # f184 毛利率: 已经是百分比（如-10.73 → -10.73%）
            # f185 净利率: 已经是百分比
            # f186 营收同比: 已经是百分比
            # f187 净利润同比: 已经是百分比
            # f188 资产负债率: 已经是百分比
            'roe': _parse_roe(data.get('f183')),
            'gross_margin': data.get('f184', None),       # 已经是%
            'net_margin': data.get('f185', None),          # 已经是%
            'revenue_yoy': data.get('f186', None),         # 已经是%
            'profit_yoy': data.get('f187', None),          # 已经是%
            'eps': data.get('f162', 0) / 100 if data.get('f162') else None,
            'bps': data.get('f163', 0) / 100 if data.get('f163') else None,
            'pe_ttm': data.get('f176', None),              # 已经是整数
            'pe_dynamic': data.get('f177', None),          # 已经是整数
            'pb': data.get('f167', 0) / 100 if data.get('f167') else None,  # /100
            'dividend_yield': data.get('f173', 0) if data.get('f173') else None,
            'debt_ratio': data.get('f188', None),          # 已经是%
        }
    except Exception as e:
        return {}


def fetch_stock_concepts(code: str) -> List[str]:
    """
    获取股票所属概念板块

    策略：通过多个数据源依次尝试，获取概念后立即返回。
    1. 东财slist接口（最快，但需正确的参数）
    2. 东财数据中心F10接口
    3. 基于行业信息的关键词匹配兜底
    """
    if code.startswith('6'):
        secid = f'1.{code}'
    else:
        secid = f'0.{code}'

    # 方案1: 通过东财 push2 slist 接口（多次尝试不同参数组合）
    for spt, fields_combo in [
        (3, 'f12,f14'),
        (3, 'f12,f14,f2,f3'),
        (1, 'f12,f14'),
        (2, 'f12,f14'),
    ]:
        try:
            url = (f'https://push2.eastmoney.com/api/qt/slist/get?secid={secid}'
                   f'&spt={spt}&fields={fields_combo}'
                   f'&ut=b2884a393a59ad64002292a3e90d46a5&fltt=2')
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://quote.eastmoney.com/',
            })
            resp = urllib.request.urlopen(req, timeout=5)
            result = json.loads(resp.read().decode('utf-8'))
            data = result.get('data', {})
            if data:
                concepts = []
                for item in data.get('slist', []):
                    name = item.get('f14', '')
                    if name and name not in ('沪市A股', '深市A股', '沪A', '深A',
                                               '主板', '中小板', '创业板', '科创板'):
                        concepts.append(name)
                if concepts:
                    return concepts
        except Exception:
            continue

    # 方案2: 通过东财数据中心 F10 接口
    try:
        url = (f'https://datacenter-web.eastmoney.com/api/data/v1/get?'
               f'reportName=RPT_F10_ORG_BASICINFO&columns=ORG_PROFILE&filter='
               f'(SECURITY_CODE="{code}")&pageNumber=1&pageSize=1&source=HSF10&client=PC')
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read().decode('utf-8')).get('result', {})
        if data and data.get('data'):
            profile = data['data'][0].get('ORG_PROFILE', '')
            if profile:
                # 从经营范围中提取关键词作为概念标签
                keywords = []
                keyword_map = {
                    '医药': '医药', '医疗': '医疗器械', '生物': '生物科技',
                    '芯片': '芯片', '半导体': '半导体', '集成电路': '芯片',
                    '新能源': '新能源', '锂电': '锂电池', '储能': '储能',
                    '光伏': '光伏', '风电': '风电', '电力': '电力设备',
                    'AI': '人工智能', '人工智能': '人工智能', '算力': '算力',
                    '数据': '数字经济', '云计算': '云计算', '软件': '软件服务',
                    '军工': '军工', '航天': '航天', '航空': '航空',
                    '汽车': '汽车', '整车': '汽车制造',
                    '地产': '房地产', '物业': '物业管理',
                    '消费': '大消费', '食品': '食品饮料', '饮料': '食品饮料',
                    '化工': '化工', '材料': '新材料',
                    '钢铁': '钢铁', '煤炭': '煤炭',
                    '银行': '银行', '金融': '金融',
                    '通信': '通信', '5G': '5G通信',
                    '教育': '教育', '旅游': '旅游',
                    '机器人': '机器人', '自动化': '智能制造',
                    '环保': '环保', '节能': '节能环保',
                }
                for kw, concept_name in keyword_map.items():
                    if kw in profile and concept_name not in keywords:
                        keywords.append(concept_name)
                if keywords:
                    return keywords[:5]
    except Exception:
        pass

    return []


def fetch_industry_info(code: str) -> str:
    """获取股票所属行业（通过f127字段）"""
    try:
        if code.startswith('6'):
            secid = f'1.{code}'
        else:
            secid = f'0.{code}'
        url = (f'https://push2.eastmoney.com/api/qt/stock/get?secid={secid}'
               f'&fields=f57,f58,f127,f128&ut=b2884a393a59ad64002292a3e90d46a5')
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urllib.request.urlopen(req, timeout=8)
        data = json.loads(resp.read().decode('utf-8')).get('data', {})
        if data:
            industry = data.get('f127', '')
            region = data.get('f128', '')
            if industry:
                return f"{industry}" + (f"（{region}）" if region else "")
            elif region:
                return region
    except:
        pass
    return ''


def fetch_main_fund_flow(code: str) -> Dict:
    """获取主力资金流向（今日）"""
    try:
        if code.startswith('6'):
            secid = f'1.{code}'
        else:
            secid = f'0.{code}'

        url = (f'https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get?'
               f'secid={secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56'
               f'&lmt=1&ut=b2884a393a59ad64002292a3e90d46a5')
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urllib.request.urlopen(req, timeout=8)
        data = json.loads(resp.read().decode('utf-8')).get('data', {})
        if data:
            klines = data.get('klines', [])
            if klines:
                parts = klines[-1].split(',')
                # 注意：东方财富资金流向单位是"元"
                # 日期,主力净流入,小单净流入,中单净流入,大单净流入,超大单净流入,...
                main_inflow = float(parts[1]) if len(parts) > 1 else 0
                big_inflow = float(parts[4]) if len(parts) > 4 else 0
                super_inflow = float(parts[5]) if len(parts) > 5 else 0
                # 转换为万元
                return {
                    'main_inflow': main_inflow / 10000,
                    'big_inflow': big_inflow / 10000,
                    'super_inflow': super_inflow / 10000,
                }
    except:
        pass
    return {'main_inflow': 0, 'big_inflow': 0, 'super_inflow': 0}


# ==================== 深度分析逻辑 ====================

def analyze_fundamentals(fin: Dict) -> Dict:
    """基本面评分与分析"""
    scores = {}
    comments = []

    # PE评价
    pe = fin.get('pe_ttm')
    if pe is not None:
        if pe < 0:
            scores['pe'] = 0
            comments.append(f"PE(TTM): {pe:.1f}（亏损）")
        elif pe < 15:
            scores['pe'] = 25
            comments.append(f"PE(TTM): {pe:.1f}（低估）")
        elif pe < 30:
            scores['pe'] = 20
            comments.append(f"PE(TTM): {pe:.1f}（合理）")
        elif pe < 60:
            scores['pe'] = 12
            comments.append(f"PE(TTM): {pe:.1f}（偏高）")
        else:
            scores['pe'] = 5
            comments.append(f"PE(TTM): {pe:.1f}（高估）")
    else:
        scores['pe'] = 10
        comments.append("PE: 数据缺失")

    # PB评价
    pb = fin.get('pb')
    if pb is not None:
        if pb < 1:
            scores['pb'] = 20
            comments.append(f"PB: {pb:.2f}（破净）")
        elif pb < 2:
            scores['pb'] = 18
            comments.append(f"PB: {pb:.2f}（低估）")
        elif pb < 4:
            scores['pb'] = 14
            comments.append(f"PB: {pb:.2f}（合理）")
        elif pb < 8:
            scores['pb'] = 8
            comments.append(f"PB: {pb:.2f}（偏高）")
        else:
            scores['pb'] = 3
            comments.append(f"PB: {pb:.2f}（高估）")
    else:
        scores['pb'] = 8
        comments.append("PB: 数据缺失")

    # ROE评价
    roe = fin.get('roe')
    if roe is not None:
        if roe >= 15:
            scores['roe'] = 20
            comments.append(f"ROE: {roe:.1f}%（优秀）")
        elif roe >= 10:
            scores['roe'] = 16
            comments.append(f"ROE: {roe:.1f}%（良好）")
        elif roe >= 5:
            scores['roe'] = 12
            comments.append(f"ROE: {roe:.1f}%（一般）")
        elif roe >= 0:
            scores['roe'] = 6
            comments.append(f"ROE: {roe:.1f}%（偏低）")
        else:
            scores['roe'] = 0
            comments.append(f"ROE: {roe:.1f}%（亏损）")
    else:
        scores['roe'] = 8
        comments.append("ROE: 数据缺失")

    # 营收增长
    rev_yoy = fin.get('revenue_yoy')
    if rev_yoy is not None:
        if rev_yoy >= 30:
            scores['revenue'] = 15
            comments.append(f"营收同比: {rev_yoy:+.1f}%（高速增长）")
        elif rev_yoy >= 10:
            scores['revenue'] = 12
            comments.append(f"营收同比: {rev_yoy:+.1f}%（稳定增长）")
        elif rev_yoy >= 0:
            scores['revenue'] = 8
            comments.append(f"营收同比: {rev_yoy:+.1f}%（微增）")
        elif rev_yoy >= -20:
            scores['revenue'] = 4
            comments.append(f"营收同比: {rev_yoy:+.1f}%（下滑）")
        else:
            scores['revenue'] = 0
            comments.append(f"营收同比: {rev_yoy:+.1f}%（大幅下滑）")
    else:
        scores['revenue'] = 6
        comments.append("营收同比: 数据缺失")

    # 净利润增长
    profit_yoy = fin.get('profit_yoy')
    if profit_yoy is not None:
        if profit_yoy >= 30:
            scores['profit'] = 20
            comments.append(f"净利润同比: {profit_yoy:+.1f}%（高速增长）")
        elif profit_yoy >= 10:
            scores['profit'] = 16
            comments.append(f"净利润同比: {profit_yoy:+.1f}%（稳定增长）")
        elif profit_yoy >= 0:
            scores['profit'] = 10
            comments.append(f"净利润同比: {profit_yoy:+.1f}%（微增）")
        elif profit_yoy >= -20:
            scores['profit'] = 5
            comments.append(f"净利润同比: {profit_yoy:+.1f}%（下滑）")
        else:
            scores['profit'] = 0
            comments.append(f"净利润同比: {profit_yoy:+.1f}%（大幅下滑）")
    else:
        scores['profit'] = 6
        comments.append("净利润同比: 数据缺失")

    total = sum(scores.values())
    return {
        'scores': scores,
        'total': total,
        'max_total': 100,
        'comments': comments,
    }


def analyze_reason(stock: Dict, fin: Dict, concepts: List[str],
                   industry: str, fund_flow: Dict) -> str:
    """
    分析涨停原因

    基于多个维度推断涨停逻辑：
    1. 概念热度（是否近期热门板块）
    2. 行业驱动（基于行业分类的热度判断）
    3. 资金面（主力资金是否大幅流入）
    4. 基本面催化剂（业绩预增、政策利好等）
    5. 技术面特征（封单强度、换手率等）
    """
    reasons = []

    # 1. 概念/板块驱动
    hot_concepts = []
    # 常见热门概念关键词
    hot_keywords = ['AI', '芯片', '半导体', '新能源', '锂电', '光伏', '储能',
                    '机器人', '算力', '数据', '军工', '一带一路', '国企改革',
                    '并购', '重组', '借壳', '地产', '消费', '医药', '创新药',
                    '华为', '苹果', '特斯拉', '低空', '飞行', '量子', '碳交易',
                    '数字经济', '人工智能', '国产替代', '自主可控', '跨境电商',
                    '固态电池', '鸿蒙', '卫星', '商业航天', '军工电子',
                    '光刻机', '消费电子', '智能驾驶', '自动泊车', '毫米波',
                    'CPO', 'PEEK', '人形机器人', '减肥药', 'AIGC', 'SORA',
                    '多模态', '大模型', '短剧', '游戏', '教育', '体育',
                    '冰雪', '旅游', '养老', '银发', '新质生产力', '设备更新',
                    '以旧换新', '碳中和', '绿电', '核能', '氢能',
                    '脑机', '量子计算', '合成生物', '低空经济']

    for concept in concepts:
        for kw in hot_keywords:
            if kw.lower() in concept.lower() and concept not in hot_concepts:
                hot_concepts.append(concept)
                break

    # 如果没有概念数据，尝试从行业信息中匹配
    if not hot_concepts and industry:
        for kw in hot_keywords:
            if kw.lower() in industry.lower():
                hot_concepts.append(industry)
                break

    if hot_concepts:
        reasons.append(f"概念驱动: {', '.join(hot_concepts[:3])}")
    elif industry:
        reasons.append(f"行业驱动: {industry}")
    else:
        reasons.append("无明显概念驱动，可能为个股事件或情绪炒作")

    # 2. 资金面（main_in 单位：万元）
    main_in = fund_flow.get('main_inflow', 0)
    if main_in > 10000:
        reasons.append(f"主力大幅流入: {main_in/10000:.1f}亿元")
    elif main_in > 5000:
        reasons.append(f"主力净流入: {main_in/10000:.1f}亿元")
    elif main_in > 0:
        reasons.append(f"主力小幅流入: {main_in:.0f}万元")
    else:
        reasons.append(f"主力净流出: {abs(main_in):.0f}万元（散户接力）")

    # 3. 基本面催化剂
    roe = fin.get('roe')
    profit_yoy = fin.get('profit_yoy')
    revenue_yoy = fin.get('revenue_yoy')
    gross_margin = fin.get('gross_margin')

    if profit_yoy is not None and profit_yoy >= 30:
        reasons.append("业绩催化剂: 净利润高增长")
    elif profit_yoy is not None and profit_yoy < -30:
        reasons.append("基本面风险: 净利润大幅下滑（纯资金/情绪驱动）")

    if revenue_yoy is not None and revenue_yoy >= 50:
        reasons.append("营收爆发增长，市场预期改善")

    if roe is not None and roe < 0:
        reasons.append("公司亏损，涨停为纯投机行为，风险较高")

    if gross_margin is not None and gross_margin > 40:
        reasons.append(f"毛利率{gross_margin:.1f}%（高毛利，护城河较深）")

    # 4. 技术面
    sealed_ratio = stock.get('sealed_ratio', 0)
    turnover = stock.get('turnover', 0)

    if sealed_ratio >= 0.10:
        reasons.append("封板极硬，多空分歧小，次日溢价概率高")
    elif sealed_ratio >= 0.03:
        reasons.append("封板较稳")
    else:
        reasons.append("封单偏弱，可能存在炸板风险")

    if turnover >= 15:
        reasons.append("换手率偏高，筹码大幅换手，分歧较大")
    elif turnover >= 8:
        reasons.append("换手率适中，筹码有一定交换")
    elif turnover >= 3:
        reasons.append("换手率健康，惜售明显")

    # 5. 综合判断
    if roe is not None and roe < 0 and main_in < 0:
        reasons.append("【高风险】亏损+主力流出，典型情绪炒作，警惕冲高回落")

    return '\n'.join([f"- {r}" for r in reasons])


def generate_final_advice(stock: Dict, fin_score: Dict, fund_flow: Dict,
                          is_chip: bool) -> str:
    """生成最终操作建议"""
    parts = []

    score_total = stock.get('总分', 0)
    fin_total = fin_score['total']

    # 综合评级
    # 涨停评分权重60%，基本面权重40%
    combined = score_total * 0.6 + fin_total * 0.4

    if combined >= 70:
        rating = "强烈关注"
        parts.append(f"综合评级: {rating}（涨停{score_total}分 + 基本面{fin_total}分，综合{combined:.0f}分）")
    elif combined >= 55:
        rating = "可关注"
        parts.append(f"综合评级: {rating}（涨停{score_total}分 + 基本面{fin_total}分，综合{combined:.0f}分）")
    elif combined >= 40:
        rating = "谨慎观望"
        parts.append(f"综合评级: {rating}（涨停{score_total}分 + 基本面{fin_total}分，综合{combined:.0f}分）")
    else:
        rating = "回避"
        parts.append(f"综合评级: {rating}（涨停{score_total}分 + 基本面{fin_total}分，综合{combined:.0f}分）")

    # 仓位建议
    position_pct = stock.get('仓位比例', 0)
    position_name = stock.get('仓位建议', '观望')

    # 基本面降权
    if fin_total < 30:
        if position_pct > 0:
            position_pct = max(position_pct * 0.3, 0.03)
            position_name = "极轻仓"
        parts.append(f"基本面较弱，仓位降至{position_pct*100:.0f}%以下")
    elif fin_total < 50:
        if position_pct > 0.15:
            position_pct = position_pct * 0.5
        parts.append(f"基本面一般，仓位控制在{position_pct*100:.0f}%以内")

    # 科创板进一步降仓
    if is_chip and position_pct > 0:
        position_pct = min(position_pct, 0.1)
        parts.append("科创板波动大，仓位严格控制在10%以内")

    # 最终建议
    if rating == "强烈关注" and position_pct >= 0.15:
        parts.append(f"建议: 明日集合竞价关注，若平开/小幅高开可{position_name}介入（{position_pct*100:.0f}%）")
    elif rating == "可关注":
        parts.append(f"建议: 可小仓位参与，{position_name}（{position_pct*100:.0f}%）")
    elif rating == "谨慎观望":
        parts.append("建议: 观望为主，若基本面后续改善可考虑")
    else:
        parts.append("建议: 回避，风险收益比不合适")

    return '\n'.join([f"- {p}" for p in parts])


# ==================== 主函数 ====================

def deep_analyze_top5(stocks: List[Dict], top_n: int = 10) -> List[Dict]:
    """
    对评分TOP N的股票进行深度分析

    Args:
        stocks: 已评分的股票列表（按分数降序排列）
        top_n: 取前N名（默认10）

    Returns:
        深度分析结果列表
    """
    # 只取主板前N名（排除科创板/创业板）
    normal_stocks = [s for s in stocks if not s.get('is_chip')][:top_n]
    if not normal_stocks:
        normal_stocks = stocks[:top_n]

    print(f"\n[深度分析] 对TOP {len(normal_stocks)} 只股票进行基本面+概念+涨停原因分析...")

    results = []

    for stock in normal_stocks:
        code = stock.get('code', '')
        name = stock.get('name', '')
        print(f"  分析 {name}({code})...")

        # 串行获取多维数据（避免并发超时互相影响）
        fin_data = {}
        concepts = []
        industry = ''
        fund_flow = {'main_inflow': 0, 'big_inflow': 0, 'super_inflow': 0}

        # 获取财务数据
        try:
            fin_data = fetch_financial_data(code)
        except Exception as e:
            print(f"    财务数据获取失败: {e}")

        # 获取概念板块
        try:
            concepts = fetch_stock_concepts(code)
        except Exception as e:
            print(f"    概念获取失败: {e}")

        # 获取行业
        try:
            industry = fetch_industry_info(code)
        except Exception as e:
            print(f"    行业获取失败: {e}")

        # 获取资金流向
        try:
            fund_flow = fetch_main_fund_flow(code)
        except Exception as e:
            print(f"    资金流向获取失败: {e}")

        # 基本面分析
        fin_analysis = analyze_fundamentals(fin_data)

        # 涨停原因分析
        reason_text = analyze_reason(stock, fin_data, concepts, industry, fund_flow)

        # 最终建议
        advice_text = generate_final_advice(
            stock, fin_analysis, fund_flow,
            stock.get('is_chip', False)
        )

        result = {
            'code': code,
            'name': name,
            'score': stock.get('总分', 0),
            'grade': stock.get('等级', ''),
            'change_pct': stock.get('change_pct', 0),
            'turnover': stock.get('turnover', 0),
            'sealed_amount': stock.get('sealed_amount', 0),
            'sealed_ratio': stock.get('sealed_ratio', 0),
            'float_cap_yi': stock.get('float_cap_yi', 0),
            'is_chip': stock.get('is_chip', False),
            # 基本面
            'financial_data': fin_data,
            'fin_analysis': fin_analysis,
            # 概念与行业
            'industry': industry,
            'concepts': concepts,
            # 资金面
            'fund_flow': fund_flow,
            # 涨停原因
            'reason': reason_text,
            # 建议
            'advice': advice_text,
        }
        results.append(result)

        # 间隔防限流
        time.sleep(0.3)

    print(f"[深度分析] 完成，共分析 {len(results)} 只股票")
    return results


if __name__ == '__main__':
    # 测试
    print("=" * 60)
    print("涨停TOP5深度分析 - 测试")
    print("=" * 60)

    test_stocks = [
        {
            'code': '002124',
            'name': '天邦食品',
            '总分': 67, '等级': 'B', 'change_pct': 10.2, 'turnover': 4.8,
            'sealed_amount': 810000000, 'sealed_ratio': 0.016,
            'float_cap_yi': 51.1, 'is_chip': False,
            '仓位建议': '极轻仓', '仓位比例': 0.05,
        },
        {
            'code': '603803',
            'name': '瑞斯康达',
            '总分': 67, '等级': 'B', 'change_pct': 10.0, 'turnover': 10.8,
            'sealed_amount': 2920000000, 'sealed_ratio': 0.045,
            'float_cap_yi': 64.8, 'is_chip': False,
            '仓位建议': '轻仓', '仓位比例': 0.15,
        },
    ]

    results = deep_analyze_top5(test_stocks)
    for r in results:
        print(f"\n{'='*50}")
        print(f"{r['name']}({r['code']}) - {r['grade']}级 {r['score']}分")
        print(f"行业: {r['industry']}")
        print(f"概念: {', '.join(r['concepts'][:5])}")
        print(f"\n基本面评分: {r['fin_analysis']['total']}/100")
        for c in r['fin_analysis']['comments']:
            print(f"  {c}")
        print(f"\n涨停原因:")
        print(r['reason'])
        print(f"\n操作建议:")
        print(r['advice'])
