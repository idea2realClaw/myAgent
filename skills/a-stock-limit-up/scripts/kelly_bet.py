#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
凯利公式仓位计算模块

凯利公式：f* = (bp - q) / b
- f*: 建议仓位比例
- b: 赔率（盈利/亏损）
- p: 胜率
- q: 败率 = 1 - p

使用说明：
- 凯利公式仅作为参考，不是预测胜率
- 建议使用半凯利（f*/2）降低风险
- 仓位计算基于客观数据（封单比例、换手率）
"""

from typing import Dict, Tuple, Optional


def estimate_win_rate(stock: Dict) -> float:
    """
    基于客观数据估算次日买入胜率

    这不是预测，而是基于历史统计的参考值
    实际胜率需要结合市场环境、板块热度等因素

    估算规则：
    - 封单比例 ≥10%: 基础胜率 +10%
    - 换手率 3-8%: 基础胜率 +5%
    - 换手率 >15% 或 <2%: 基础胜率 -10%
    - 市值 10-50亿: 基础胜率 +5%
    - 20cm涨停: 基础胜率 -5%（波动大）
    """
    sealed_ratio = stock.get('sealed_ratio', 0)
    turnover = stock.get('turnover', 0)
    float_cap_yi = stock.get('float_cap_yi', 0)
    change_pct = abs(stock.get('change_pct', 0))

    # 基础胜率（基于历史统计）
    base_rate = 0.55

    # 封单比例调整
    if sealed_ratio >= 0.10:
        base_rate += 0.10
    elif sealed_ratio >= 0.05:
        base_rate += 0.05
    elif sealed_ratio >= 0.02:
        base_rate += 0.02
    elif sealed_ratio < 0.01:
        base_rate -= 0.08

    # 换手率调整
    if 3 <= turnover <= 8:
        base_rate += 0.05
    elif 8 < turnover <= 12:
        base_rate += 0.02
    elif turnover > 15:
        base_rate -= 0.10
    elif turnover < 2:
        base_rate -= 0.05

    # 市值调整
    if 10 <= float_cap_yi <= 50:
        base_rate += 0.05
    elif float_cap_yi < 5 or float_cap_yi > 100:
        base_rate -= 0.05

    # 涨幅调整
    if change_pct >= 19.9:
        base_rate -= 0.05  # 20cm波动大

    # 限制范围
    return max(0.30, min(0.75, base_rate))


def calculate_kelly_position(stock: Dict, capital: float = 1000000) -> Dict:
    """
    计算凯利公式仓位建议

    Args:
        stock: 股票信息字典
        capital: 资金总额（默认100万）

    Returns:
        仓位建议字典
    """
    # 估算胜率
    win_rate = estimate_win_rate(stock)

    # 假设参数（可根据实际情况调整）
    # 假设次日盈利目标4%，止损2%
    profit_pct = 0.04   # 盈利4%
    loss_pct = 0.025    # 止损2.5%

    # 赔率
    b = profit_pct / loss_pct  # 1.6

    # 败率
    q = 1 - win_rate

    # 凯利公式：f* = (bp - q) / b
    kelly_full = (b * win_rate - q) / b

    # 半凯利（更保守）
    kelly_half = kelly_full / 2

    # 仓位限制
    kelly_full = max(0, min(1, kelly_full))
    kelly_half = max(0, min(0.5, kelly_half))

    # 计算金额
    position_full = capital * kelly_full
    position_half = capital * kelly_half

    # 预期收益和风险
    expected_return = kelly_half * (win_rate * profit_pct - q * loss_pct) * capital
    expected_return_pct = win_rate * profit_pct - q * loss_pct

    # 风险等级
    if kelly_half >= 0.3:
        risk_level = "高风险"
    elif kelly_half >= 0.2:
        risk_level = "中等风险"
    elif kelly_half >= 0.1:
        risk_level = "较低风险"
    else:
        risk_level = "低风险"

    return {
        'win_rate': win_rate,
        'b': b,
        'profit_pct': profit_pct * 100,
        'loss_pct': loss_pct * 100,
        'kelly_full': kelly_full,
        'kelly_half': kelly_half,
        'position_full': position_full,
        'position_half': position_half,
        'expected_return': expected_return,
        'expected_return_pct': expected_return_pct * 100,
        'risk_level': risk_level,
        'capital': capital,
    }


def format_kelly_result(result: Dict) -> str:
    """格式化凯利公式结果"""
    lines = [
        f"{'凯利公式分析':-^30}",
        f"  估算胜率: {result['win_rate']:.1%}",
        f"  赔率(b): {result['b']:.2f} (涨{result['profit_pct']:.1f}%/跌{result['loss_pct']:.1f}%)",
        f"",
        f"  满仓凯利: {result['kelly_full']:.1%} → 金额 {result['position_full']:,.0f}元",
        f"  半仓凯利: {result['kelly_half']:.1%} → 金额 {result['position_half']:,.0f}元",
        f"",
        f"  预期收益: {result['expected_return_pct']:.2f}% (约 {result['expected_return']:,.0f}元)",
        f"  风险等级: {result['risk_level']}",
    ]
    return '\n'.join(lines)


def calculate_position_for_capital(stock: Dict, capital: float, risk_level: str = 'normal') -> Dict:
    """
    根据资金和风险偏好计算仓位

    Args:
        stock: 股票信息
        capital: 总资金
        risk_level: 风险偏好 (conservative/normal/aggressive)

    Returns:
        仓位建议
    """
    kelly = calculate_kelly_position(stock, capital)

    # 根据风险偏好调整
    if risk_level == 'conservative':
        ratio = 0.5  # 半凯利的一半
    elif risk_level == 'aggressive':
        ratio = kelly.kelly_full if hasattr(kelly, 'kelly_full') else kelly['kelly_full']
    else:
        ratio = kelly['kelly_half']

    amount = capital * ratio

    return {
        'ratio': ratio,
        'amount': amount,
        'kelly_result': kelly,
    }


if __name__ == '__main__':
    # 测试数据
    test_stock = {
        'code': '002361',
        'name': '神剑股份',
        'change_pct': 10.0,
        'turnover': 33.14,
        'sealed_amount': 836000000,
        'sealed_ratio': 0.0757,  # 7.57%
        'float_cap_yi': 110.36,
    }

    print("="*50)
    print("凯利公式仓位计算")
    print("="*50)
    print(f"\n{test_stock['name']} ({test_stock['code']})")
    print(f"  涨跌幅: {test_stock['change_pct']:.2f}%")
    print(f"  换手率: {test_stock['turnover']:.2f}%")
    print(f"  封单比例: {test_stock['sealed_ratio']:.2%}")
    print(f"  流通市值: {test_stock['float_cap_yi']:.1f}亿")

    result = calculate_kelly_position(test_stock, capital=1000000)

    print()
    print(format_kelly_result(result))
