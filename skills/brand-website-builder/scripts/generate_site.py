#!/usr/bin/env python3
"""
generate_site.py — 品牌网站生成器
用法:
  python3 generate_site.py --config brand.json --output ./my-website
  python3 generate_site.py --interactive --output ./my-website
"""

import os
import sys
import json
import shutil
import argparse
import datetime

# 模板目录（相对于本脚本）
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(SCRIPT_DIR, '..', 'assets', 'website-template')

# ── 默认品牌配置（可被 brand.json 覆盖）─────────────────────────
DEFAULT_CONFIG = {
    # 公司基本信息
    "COMPANY_NAME":    "示例科技",
    "COMPANY_TAGLINE": "专注于企业数字化转型解决方案",
    "COMPANY_ADDRESS": "广东省深圳市南山区科技园南路1号",
    "COMPANY_PHONE":   "400-888-8888",
    "COMPANY_EMAIL":   "contact@example.com",
    "COMPANY_ICP":     "粤ICP备XXXXXXXX号",
    "YEAR":            str(datetime.date.today().year),

    # 品牌色（CSS 变量值）
    "BRAND_PRIMARY":   "#1A56DB",
    "BRAND_SECONDARY": "#0E9F6E",
    "BRAND_ACCENT":    "#FF5A1F",
    "BRAND_DARK":      "#111928",
    "BRAND_DARKER":    "#0D1526",

    # Logo
    "LOGO_ICON": "🚀",

    # Hero 区域
    "HERO_BADGE":    "✦ 行业领先解决方案提供商",
    "HERO_TITLE":    "驱动企业数字化增长",
    "HERO_SUBTITLE": "我们提供专业的企业数字化转型服务，助力您的业务实现跨越式发展，在竞争激烈的市场中保持领先地位。",
    "CTA_PRIMARY":   "免费获取方案",
    "CTA_SECONDARY": "了解我们",

    # Hero 统计数据
    "STAT1_NUM":   "500+",
    "STAT1_LABEL": "服务客户",
    "STAT2_NUM":   "98%",
    "STAT2_LABEL": "客户满意度",
    "STAT3_NUM":   "10年",
    "STAT3_LABEL": "行业经验",

    # Hero 浮动卡片
    "CARD1_ICON": "📊",
    "CARD1_TEXT": "数据驱动决策",
    "CARD2_ICON": "⚡",
    "CARD2_TEXT": "高效交付方案",

    # About 区域
    "ABOUT_TAG":        "关于我们",
    "ABOUT_TITLE":      "十年深耕，值得信赖的合作伙伴",
    "ABOUT_DESC":       "我们专注于为企业提供全方位的数字化解决方案，用技术赋能每一个商业梦想。",
    "ABOUT_BODY":       "自成立以来，我们始终坚持以客户价值为核心，凭借深厚的行业积累和持续的技术创新，服务了超过500家各行业领头企业，帮助他们实现了数字化转型升级。",
    "FEATURE1":         "专业的行业解决方案团队",
    "FEATURE2":         "7×24 小时技术支持保障",
    "FEATURE3":         "敏捷交付，持续迭代优化",
    "FEATURE4":         "完善的售后服务体系",
    "ABOUT_ICON":       "🏆",
    "ABOUT_CARD_TITLE": "行业认可",
    "ABOUT_CARD_DESC":  "连续三年荣获中国最佳数字化服务商奖项，获得 ISO 27001 信息安全认证。",

    # Services 区域
    "SERVICES_TAG":   "我们的服务",
    "SERVICES_TITLE": "全方位企业数字化服务",
    "SERVICES_DESC":  "从战略咨询到落地实施，我们提供端到端的一体化服务体系。",
    "SVC1_ICON": "🧭", "SVC1_TITLE": "战略咨询",   "SVC1_DESC": "深度行业洞察与数字化转型战略规划，为企业发展指明方向。",
    "SVC2_ICON": "💻", "SVC2_TITLE": "系统开发",   "SVC2_DESC": "定制化企业级系统开发，覆盖 Web、移动端及小程序全平台。",
    "SVC3_ICON": "☁️", "SVC3_TITLE": "云端部署",   "SVC3_DESC": "安全、稳定、弹性的云架构方案，支撑业务高速增长需求。",
    "SVC4_ICON": "📈", "SVC4_TITLE": "数据分析",   "SVC4_DESC": "大数据平台搭建与智能分析，让数据真正成为核心资产。",
    "SVC5_ICON": "🔒", "SVC5_TITLE": "安全保障",   "SVC5_DESC": "全链路安全防护体系，保障企业数据资产安全无忧。",
    "SVC6_ICON": "🤝", "SVC6_TITLE": "运维支持",   "SVC6_DESC": "专业运维团队全年无休驻守，确保系统稳定高效运行。",

    # Cases 区域
    "CASES_TAG":    "成功案例",
    "CASES_TITLE":  "他们选择了我们",
    "CASES_DESC":   "来自不同行业的领头企业，都在这里找到了适合自己的数字化答案。",
    "CASE1_TITLE":  "某头部零售集团数字化升级",
    "CASE1_DESC":   "整合线上线下渠道，搭建统一会员体系，实现销售额同比增长 42%，库存周转率提升 35%。",
    "CASE2_TITLE":  "制造企业智能工厂改造",
    "CASE2_DESC":   "引入 IoT 传感网络与智能调度系统，生产效率提升 58%，质量缺陷率下降 76%。",
    "CASE3_TITLE":  "金融机构风控系统重构",
    "CASE3_DESC":   "自研实时风控引擎，毫秒级决策响应，欺诈损失率下降 89%，合规成本显著降低。",

    # Contact 区域
    "CONTACT_TAG":   "联系我们",
    "CONTACT_TITLE": "开启您的数字化之旅",
    "CONTACT_DESC":  "填写下方表单，我们的专业顾问将在 24 小时内与您取得联系。",

    # Footer
    "FOOTER_DESC": "专注企业数字化转型，用技术赋能商业增长，成为您最可信赖的长期合作伙伴。",
}

# ── CSS 品牌色注入片段 ──────────────────────────────────────────
BRAND_OVERRIDE_CSS = """\
/* ── 品牌色覆盖（由 generate_site.py 自动注入）── */
:root {{
  --brand-primary:   {BRAND_PRIMARY};
  --brand-secondary: {BRAND_SECONDARY};
  --brand-accent:    {BRAND_ACCENT};
  --brand-dark:      {BRAND_DARK};
  --brand-darker:    {BRAND_DARKER};
}}
"""


def load_config(path: str) -> dict:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def interactive_config() -> dict:
    """引导用户交互输入品牌配置"""
    cfg = DEFAULT_CONFIG.copy()
    print("\n=== 品牌网站生成器 — 交互模式 ===")
    print("直接回车跳过，使用默认值\n")

    fields = [
        ("COMPANY_NAME",    "公司名称"),
        ("COMPANY_TAGLINE", "公司标语（一句话描述）"),
        ("COMPANY_ADDRESS", "公司地址"),
        ("COMPANY_PHONE",   "联系电话"),
        ("COMPANY_EMAIL",   "联系邮箱"),
        ("COMPANY_ICP",     "网站备案号"),
        ("BRAND_PRIMARY",   "主品牌色（HEX，如 #1A56DB）"),
        ("BRAND_SECONDARY", "辅助色（HEX，如 #0E9F6E）"),
        ("BRAND_ACCENT",    "强调色（HEX，如 #FF5A1F）"),
        ("LOGO_ICON",       "Logo 图标（Emoji 或留空）"),
        ("HERO_BADGE",      "Hero 徽章文字"),
        ("HERO_TITLE",      "Hero 主标题（可含 HTML）"),
        ("HERO_SUBTITLE",   "Hero 副标题"),
        ("CTA_PRIMARY",     "主按钮文字"),
        ("CTA_SECONDARY",   "次按钮文字"),
        ("STAT1_NUM",       "统计数据1（数字）"),
        ("STAT1_LABEL",     "统计数据1（标签）"),
        ("STAT2_NUM",       "统计数据2（数字）"),
        ("STAT2_LABEL",     "统计数据2（标签）"),
        ("STAT3_NUM",       "统计数据3（数字）"),
        ("STAT3_LABEL",     "统计数据3（标签）"),
    ]

    for key, label in fields:
        val = input(f"  {label} [{cfg[key]}]: ").strip()
        if val:
            cfg[key] = val

    return cfg


def apply_config(template_content: str, cfg: dict) -> str:
    """将 {{KEY}} 占位符替换为配置值"""
    result = template_content
    for key, value in cfg.items():
        result = result.replace('{{' + key + '}}', str(value))
    return result


def generate_site(cfg: dict, output_dir: str):
    # 1. 复制模板目录
    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)
    shutil.copytree(TEMPLATE_DIR, output_dir)

    # 2. 替换 index.html 中的占位符
    html_path = os.path.join(output_dir, 'index.html')
    with open(html_path, 'r', encoding='utf-8') as f:
        html = f.read()
    html = apply_config(html, cfg)
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)

    # 3. 注入品牌色到 styles.css 顶部
    css_path = os.path.join(output_dir, 'styles.css')
    with open(css_path, 'r', encoding='utf-8') as f:
        original_css = f.read()
    brand_css = BRAND_OVERRIDE_CSS.format(**cfg)
    with open(css_path, 'w', encoding='utf-8') as f:
        f.write(brand_css + '\n' + original_css)

    # 4. 输出摘要
    print(f"\n✅ 网站生成完成！")
    print(f"   输出目录: {os.path.abspath(output_dir)}")
    print(f"   入口文件: {os.path.abspath(html_path)}")
    print(f"   公司名称: {cfg.get('COMPANY_NAME')}")
    print(f"   主品牌色: {cfg.get('BRAND_PRIMARY')}")
    print(f"\n   用浏览器打开 index.html 即可预览 🎉\n")


def main():
    parser = argparse.ArgumentParser(description='品牌网站生成器')
    parser.add_argument('--config',      '-c', help='品牌配置 JSON 文件路径')
    parser.add_argument('--output',      '-o', default='./generated-website', help='输出目录（默认 ./generated-website）')
    parser.add_argument('--interactive', '-i', action='store_true', help='交互模式，逐步输入品牌信息')
    parser.add_argument('--print-schema',      action='store_true', help='打印完整 brand.json 模板')
    args = parser.parse_args()

    if args.print_schema:
        print(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2))
        return

    if args.config:
        cfg = {**DEFAULT_CONFIG, **load_config(args.config)}
    elif args.interactive:
        cfg = interactive_config()
    else:
        print("提示：未指定配置，使用默认品牌信息生成演示网站。")
        print("      使用 --config brand.json 或 --interactive 来自定义品牌。\n")
        cfg = DEFAULT_CONFIG.copy()

    generate_site(cfg, args.output)


if __name__ == '__main__':
    main()
