#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
涨停板客观评分系统 v6

三大评分维度：
1. 封板强度 (40分) - 封单/流通市值比例，核心指标
2. 换手健康 (30分) - 换手率是否在合理区间
3. 行业赛道 (30分) - 板块热度 + 题材强度 + 基本面

满分100分，主板/科创板统一评分标准，但科创板仓位更保守。
"""

from typing import List, Dict, Tuple


# ============================================================
# 行业赛道评分表（热点板块映射）
# ============================================================

# S级赛道（当前市场最强主线，30分满分）
S_TRACKS = {
    '锂电', '锂电池', '储能', '锂矿', '碳酸锂', '锂电材料', '正极材料',
    '负极材料', '电解液', '隔膜', '锂辉石', '锂云母', '盐湖提锂',
    '固态电池', '钠离子电池', '动力电池',
    '算力', '算力租赁', 'GPU', 'CPO', '光模块', '光芯片',
    'AI服务器', 'AI芯片', '先进封装', '玻璃基板',
}

# A级赛道（近期活跃热点，25分）
A_TRACKS = {
    '半导体', '芯片', '半导体设备', '半导体材料', '封测',
    '光刻胶', '靶材', '特气', '掩模版', '电子气体',
    '稀土', '稀土永磁', '钨', '小金属',
    '机器人', '人形机器人', '具身智能', '工业机器人',
    '商业航天', '卫星', '低轨卫星',
    '光伏', '风电', '新能源',
}

# B级赛道（有催化的一般板块，20分）
B_TRACKS = {
    '消费电子', '消费电子零部件', 'VR', 'AR', 'MR',
    '医药', '创新药', 'CXO', '医疗器械', '体外诊断',
    '汽车', '智能驾驶', '自动驾驶', '新能源汽车', '汽车零部件',
    '数字经济', '数据要素', '信创',
    '军工', '国防军工', '航空航天',
    '通信', '5G', '6G',
    'PCB', '覆铜板', '玻纤',
    '食品', '白酒', '化妆品', '美妆',
}

# C级赛道（无特别催化的普通板块，10分）
C_TRACKS = {
    '房地产', '银行', '保险', '券商',
    '纺织', '服装', '家居', '建筑装饰',
    '钢铁', '煤炭', '水泥', '化工',
    '传媒', '游戏', '教育',
    '农业', '养殖业', '食品加工',
    '环保', '电力', '公用事业',
    '物流', '快递', '交通运输',
}


def _match_track(keywords: List[str]) -> Tuple[int, str, str]:
    """
    根据股票的关键词/概念匹配赛道等级。
    
    返回: (分数, 等级标签, 匹配到的赛道名)
    """
    if not keywords:
        return 15, 'C', '未知'

    keyword_str = ' '.join(keywords).lower()

    # S级
    for track in S_TRACKS:
        if track.lower() in keyword_str:
            return 30, 'S', track

    # A级
    for track in A_TRACKS:
        if track.lower() in keyword_str:
            return 25, 'A', track

    # B级
    for track in B_TRACKS:
        if track.lower() in keyword_str:
            return 20, 'B', track

    # C级
    for track in C_TRACKS:
        if track.lower() in keyword_str:
            return 10, 'C', track

    return 15, 'C', '其他'


# ============================================================
# 三大评分维度
# ============================================================

def score_sealed_amount(stock: Dict) -> Tuple[int, str]:
    """
    维度一：封板强度 (满分40分)
    
    核心：封单金额 / 流通市值 的比例（封单力度）
    """
    ratio = stock.get('sealed_ratio', 0)

    if ratio >= 0.15:
        return 40, "极强(≥15%)"
    elif ratio >= 0.10:
        return 35, "很强(≥10%)"
    elif ratio >= 0.07:
        return 30, "强(≥7%)"
    elif ratio >= 0.05:
        return 25, "较强(≥5%)"
    elif ratio >= 0.03:
        return 20, "中等(≥3%)"
    elif ratio >= 0.02:
        return 15, "一般(≥2%)"
    elif ratio >= 0.01:
        return 10, "偏弱(≥1%)"
    else:
        return 5, "极弱(<1%)"


def score_turnover(stock: Dict) -> Tuple[int, str]:
    """
    维度二：换手健康度 (满分30分)
    
    主板：3-8%最佳区间，筹码交换充分但不分歧
    科创/创业板：5-15%最佳区间（波动大，换手天然偏高）
    """
    turnover = stock.get('turnover', 0)
    is_chip = stock.get('is_chip', False)

    if is_chip:
        if 5 <= turnover <= 15:
            return 30, "健康(5-15%)"
        elif 3 <= turnover < 5 or 15 < turnover <= 25:
            return 22, "尚可"
        elif 1 <= turnover < 3 or 25 < turnover <= 35:
            return 15, "偏高/偏低"
        else:
            return 5, "异常"
    else:
        if 3 <= turnover <= 8:
            return 30, "健康(3-8%)"
        elif 2 <= turnover < 3 or 8 < turnover <= 12:
            return 22, "尚可"
        elif 1 <= turnover < 2 or 12 < turnover <= 20:
            return 15, "偏高/偏低"
        elif turnover > 20 or turnover < 1:
            return 5, "异常"
        else:
            return 10, "偏低"


def score_industry_track(stock: Dict) -> Tuple[int, str]:
    """
    维度三：行业赛道 (满分30分)
    
    基于股票所属板块和概念题材评分。
    数据来源：stock['concepts']（概念标签列表）
    
    评分逻辑：
    - S级赛道（当前最强主线）：30分
    - A级赛道（近期活跃热点）：25分
    - B级赛道（有催化的一般板块）：20分
    - C级赛道（普通板块）：10分
    - 未知/无概念：15分
    """
    concepts = stock.get('concepts', [])
    if isinstance(concepts, str):
        concepts = [concepts]

    score, grade, track_name = _match_track(concepts)
    return score, f"{grade}级·{track_name}"


# ============================================================
# 综合评分
# ============================================================

def calculate_objective_score(stock: Dict) -> Dict:
    """计算股票客观评分（v6三维度）"""
    is_chip = stock.get('is_chip', False)

    # 三维度评分
    sealed_score, sealed_desc = score_sealed_amount(stock)
    turnover_score, turnover_desc = score_turnover(stock)
    track_score, track_desc = score_industry_track(stock)

    # 总分 = 封板40 + 换手30 + 赛道30 = 100
    total_score = sealed_score + turnover_score + track_score

    # 等级划分（主板和科创板统一标准）
    if total_score >= 85:
        grade = "S"
        grade_desc = "极强"
    elif total_score >= 70:
        grade = "A"
        grade_desc = "强"
    elif total_score >= 55:
        grade = "B"
        grade_desc = "中等"
    elif total_score >= 40:
        grade = "C"
        grade_desc = "较弱"
    else:
        grade = "D"
        grade_desc = "观望"

    # 仓位建议
    position = calculate_position(stock, sealed_score, turnover_score, track_score, is_chip)

    return {
        'code': stock.get('code', ''),
        'name': stock.get('name', ''),

        # 原始数据
        'change_pct': stock.get('change_pct', 0),
        'turnover': stock.get('turnover', 0),
        'sealed_amount': stock.get('sealed_amount', 0),
        'sealed_ratio': stock.get('sealed_ratio', 0),
        'float_cap_yi': stock.get('float_cap_yi', 0),
        'is_chip': is_chip,
        'open_gap': stock.get('open_gap', 0),
        'can_buy': stock.get('can_buy', True),
        'concepts': stock.get('concepts', []),

        # 评分详情
        '封板强度': sealed_score,
        '封板评价': sealed_desc,
        '换手健康': turnover_score,
        '换手评价': turnover_desc,
        '行业赛道': track_score,
        '赛道评价': track_desc,

        # 总分
        '总分': total_score,
        '等级': grade,
        '等级描述': grade_desc,

        # 仓位建议
        '仓位建议': position['仓位'],
        '仓位比例': position['比例'],
        '风险等级': position['风险'],
    }


def calculate_position(stock: Dict, sealed_score: int, turnover_score: int,
                       track_score: int, is_chip: bool) -> Dict:
    """基于三维度评分计算仓位建议"""
    sealed_ratio = stock.get('sealed_ratio', 0)
    turnover = stock.get('turnover', 0)
    can_buy = stock.get('can_buy', True)
    total = sealed_score + turnover_score + track_score

    # 风险等级
    if not can_buy:
        risk = "高风险"
        return {'仓位': "不建议", '比例': 0, '风险': risk}

    if turnover > 35:
        risk = "高风险"
        return {'仓位': "不建议", '比例': 0, '风险': risk}

    if turnover > 25:
        risk = "较高风险"
    elif turnover > 15:
        risk = "中等风险"
    else:
        risk = "正常"

    # 科创板/创业板仓位降低
    if is_chip:
        if sealed_score >= 30 and turnover_score >= 22 and track_score >= 25:
            return {'仓位': "轻仓", '比例': 0.15, '风险': risk}
        elif total >= 55:
            return {'仓位': "极轻仓", '比例': 0.05, '风险': risk}
        else:
            return {'仓位': "观望", '比例': 0, '风险': risk}
    else:
        # 主板
        if sealed_score >= 30 and turnover_score >= 22 and track_score >= 25:
            return {'仓位': "重仓", '比例': 0.40, '风险': risk}
        elif sealed_score >= 25 and turnover_score >= 20 and track_score >= 20:
            return {'仓位': "半仓", '比例': 0.25, '风险': risk}
        elif total >= 50:
            return {'仓位': "轻仓", '比例': 0.15, '风险': risk}
        elif total >= 35:
            return {'仓位': "极轻仓", '比例': 0.05, '风险': risk}
        else:
            return {'仓位': "观望", '比例': 0, '风险': risk}


def rank_stocks(stocks: List[Dict]) -> List[Dict]:
    """对涨停股票进行客观评分和排名"""
    # 分离主板和科创板
    chip_stocks = [s for s in stocks if s.get('is_chip')]
    normal_stocks = [s for s in stocks if not s.get('is_chip')]

    # 主板评分排名
    scored_normal = []
    for stock in normal_stocks:
        score = calculate_objective_score(stock)
        scored_normal.append(score)

    scored_normal.sort(key=lambda x: x['总分'], reverse=True)

    # 添加排名
    for i, s in enumerate(scored_normal, 1):
        s['排名'] = i

    # 科创板单独列出
    scored_chip = []
    for stock in chip_stocks:
        score = calculate_objective_score(stock)
        scored_chip.append(score)

    scored_chip.sort(key=lambda x: x['总分'], reverse=True)
    for i, s in enumerate(scored_chip, 1):
        s['排名'] = i

    return {
        'normal': scored_normal,
        'chip': scored_chip,
    }


def analyze_limit_up(stocks: List[Dict]) -> Dict:
    """分析涨停股票"""
    result = rank_stocks(stocks)

    normal = result['normal']
    chip = result['chip']

    # 分类统计
    s_class = [s for s in normal if s['等级'] == 'S']
    a_class = [s for s in normal if s['等级'] == 'A']
    b_class = [s for s in normal if s['等级'] == 'B']
    c_class = [s for s in normal if s['等级'] == 'C']
    d_class = [s for s in normal if s['等级'] == 'D']

    # 平均分
    avg_score = sum(s['总分'] for s in normal) / len(normal) if normal else 0

    # 统计涨幅分布
    all_scored = normal + chip
    change_20cm = [s for s in all_scored if s['change_pct'] >= 19.9]
    change_10cm = [s for s in all_scored if 9.9 <= s['change_pct'] < 19.9]

    # 开盘可买入数量
    can_buy_count = len([s for s in normal if s['can_buy']])

    return {
        'normal_stocks': normal,
        'chip_stocks': chip,
        'all_stocks': normal + chip,
        's_class': s_class,
        'a_class': a_class,
        'b_class': b_class,
        'c_class': c_class,
        'd_class': d_class,
        'avg_score': avg_score,
        'total_count': len(normal) + len(chip),
        'normal_count': len(normal),
        'chip_count': len(chip),
        'can_buy_count': can_buy_count,
        'change_20cm_count': len(change_20cm),
        'change_10cm_count': len(change_10cm),
    }


if __name__ == '__main__':
    # 测试数据
    test_stocks = [
        {
            'code': '002192',
            'name': '融捷股份',
            'change_pct': 10.0,
            'turnover': 5.2,
            'sealed_amount': 500000000,
            'sealed_ratio': 0.08,
            'float_cap_yi': 62.5,
            'is_chip': False,
            'open_gap': 2.0,
            'can_buy': True,
            'concepts': ['锂电', '锂矿', '碳酸锂'],
        },
        {
            'code': '300438',
            'name': '鹏辉能源',
            'change_pct': 20.0,
            'turnover': 8.5,
            'sealed_amount': 300000000,
            'sealed_ratio': 0.05,
            'float_cap_yi': 60.0,
            'is_chip': True,
            'open_gap': 5.0,
            'can_buy': True,
            'concepts': ['储能', '锂电池', '动力电池'],
        },
        {
            'code': '002081',
            'name': '金螳螂',
            'change_pct': 10.0,
            'turnover': 3.5,
            'sealed_amount': 200000000,
            'sealed_ratio': 0.06,
            'float_cap_yi': 33.3,
            'is_chip': False,
            'open_gap': 1.0,
            'can_buy': True,
            'concepts': ['建筑装饰', '半导体洁净室'],
        },
    ]

    print("=" * 70)
    print("涨停板客观评分测试 v6（三维度）")
    print("=" * 70)

    result = analyze_limit_up(test_stocks)

    for s in result['all_stocks']:
        chip_tag = " [科创]" if s['is_chip'] else ""
        print(f"\n{s['name']} ({s['code']}){chip_tag} — {s['等级']}级 {s['总分']}分")
        print(f"  封板强度: {s['封板强度']}/40 ({s['封板评价']})")
        print(f"  换手健康: {s['换手健康']}/30 ({s['换手评价']})")
        print(f"  行业赛道: {s['行业赛道']}/30 ({s['赛道评价']})")
        print(f"  仓位建议: {s['仓位建议']} ({s['仓位比例']*100:.0f}%)")
        print(f"  风险等级: {s['风险等级']}")
