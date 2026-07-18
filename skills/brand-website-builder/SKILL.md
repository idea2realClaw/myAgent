---
name: brand-website-builder
description: "This skill should be used when the user wants to create a brand website for a company. It generates a complete, responsive HTML5 website that adapts to both desktop and mobile devices. The website supports full brand customization: colors, company name, tagline, hero, services, cases, and contact info. Trigger phrases: 创建网站, 生成网站, 品牌网站, 公司官网, 企业官网, 做一个网站, build website, corporate website, responsive website."
---

# Brand Website Builder

## 概述

根据公司品牌信息，生成一套完整的响应式 HTML5 企业官网，电脑端和手机端均自适应。网站包含以下板块：

- **导航栏**：固定顶部，滚动后背景变实色，移动端汉堡菜单
- **Hero**：全屏品牌展示 + 统计数据 + 浮动卡片
- **关于我们**：公司介绍 + 特色亮点
- **服务/产品**：6 宫格卡片，支持高亮核心服务
- **成功案例**：3 个代表案例
- **联系我们**：联系信息 + 咨询表单
- **Footer**：多列布局 + 备案号

## 工作流程

### Step 1：收集品牌信息

向用户提问（不要一次全问，分 2-3 轮，按重要性排序）：

**第一轮（核心信息）：**
- 公司名称、一句话标语
- 主品牌色（HEX）
- 主营业务 / 行业

**第二轮（内容细节）：**
- 服务项目（最多 6 项，每项需标题 + 一句描述）
- 成功案例（最多 3 个）
- 联系方式（地址、电话、邮箱）

**第三轮（可选补充）：**
- 统计数据（如"500+ 客户"、"98% 满意度"）
- Hero 浮动卡片文案
- 网站备案号

### Step 2：运行生成脚本

收集完品牌信息后，调用 `scripts/generate_site.py` 生成网站。

**方法 A：直接传入配置字典（推荐）**

根据收集到的用户信息，构建 brand.json 配置文件，然后运行：

```bash
python3 ~/.workbuddy/skills/brand-website-builder/scripts/generate_site.py \
  --config /path/to/brand.json \
  --output /path/to/output-dir
```

**方法 B：生成默认演示（用户只想快速预览）**

```bash
python3 ~/.workbuddy/skills/brand-website-builder/scripts/generate_site.py \
  --output /path/to/output-dir
```

**查看完整配置字段：**

```bash
python3 ~/.workbuddy/skills/brand-website-builder/scripts/generate_site.py --print-schema
```

### Step 3：品牌色定制

生成脚本会自动在 `styles.css` 顶部注入品牌色覆盖：

```css
:root {
  --brand-primary:   #HEX;   /* 主色，用于按钮、链接、标签 */
  --brand-secondary: #HEX;   /* 辅色，用于勾选标记、次要高亮 */
  --brand-accent:    #HEX;   /* 强调色，用于徽章、特殊标注 */
  --brand-dark:      #HEX;   /* 深色背景（Hero/Footer） */
  --brand-darker:    #HEX;   /* 更深色背景 */
}
```

常用品牌色参考：
- 科技/互联网：primary `#1A56DB`（蓝）、accent `#FF5A1F`（橙）
- 金融/专业服务：primary `#1C3A5E`（深蓝）、accent `#C9A84C`（金）
- 医疗/健康：primary `#0E9F6E`（绿）、accent `#3F83F8`（蓝）
- 教育：primary `#7E3AF2`（紫）、accent `#F05252`（红）
- 零售/消费：primary `#E02424`（红）、accent `#FF8A4C`（橙）

### Step 4：输出与交付

生成完成后：
1. 用 `preview_url` 工具预览（如已启动本地服务）；或
2. 告知用户用浏览器直接打开 `output/index.html`；
3. 如用户需要进一步调整，直接修改输出目录下的文件，说明对应的 CSS 变量或 HTML 位置。

## brand.json 配置字段说明

| 字段 | 说明 | 示例 |
|------|------|------|
| COMPANY_NAME | 公司名称 | "极光科技" |
| COMPANY_TAGLINE | 网站 meta description | "专注数字营销" |
| COMPANY_ADDRESS | 地址 | "北京市朝阳区..." |
| COMPANY_PHONE | 电话 | "400-000-0000" |
| COMPANY_EMAIL | 邮箱 | "hi@example.com" |
| COMPANY_ICP | 备案号 | "京ICP备XXXXXXXX号" |
| BRAND_PRIMARY | 主色 HEX | "#1A56DB" |
| BRAND_SECONDARY | 辅色 HEX | "#0E9F6E" |
| BRAND_ACCENT | 强调色 HEX | "#FF5A1F" |
| BRAND_DARK | 深色背景 HEX | "#111928" |
| BRAND_DARKER | 更深背景 HEX | "#0D1526" |
| LOGO_ICON | Logo Emoji | "🚀" |
| HERO_BADGE | Hero 徽章 | "✦ 行业领先" |
| HERO_TITLE | Hero 主标题（支持 HTML span 高亮关键词） | "驱动增长" |
| HERO_SUBTITLE | Hero 副标题 | "一句话描述..." |
| CTA_PRIMARY | 主按钮文字 | "免费咨询" |
| CTA_SECONDARY | 次按钮文字 | "了解更多" |
| STAT1_NUM ~ STAT3_NUM | 统计数字 | "500+", "98%", "10年" |
| STAT1_LABEL ~ STAT3_LABEL | 统计标签 | "服务客户" |
| CARD1_ICON / CARD2_ICON | 浮动卡片图标 | "📊" |
| CARD1_TEXT / CARD2_TEXT | 浮动卡片文字 | "数据驱动" |
| ABOUT_TAG | About 区域标签 | "关于我们" |
| ABOUT_TITLE | About 标题 | "十年深耕..." |
| ABOUT_DESC | About 副标题 | "..." |
| ABOUT_BODY | About 正文段落 | "..." |
| FEATURE1 ~ FEATURE4 | 四项特色亮点 | "专业团队" |
| ABOUT_ICON | About 卡片图标 | "🏆" |
| ABOUT_CARD_TITLE | About 卡片标题 | "行业认可" |
| ABOUT_CARD_DESC | About 卡片描述 | "..." |
| SERVICES_TAG | 服务区标签 | "我们的服务" |
| SERVICES_TITLE | 服务区标题 | "全方位服务" |
| SERVICES_DESC | 服务区副标题 | "..." |
| SVC1~6_ICON | 服务图标 Emoji | "💻" |
| SVC1~6_TITLE | 服务标题 | "系统开发" |
| SVC1~6_DESC | 服务描述 | "..." |
| CASES_TAG | 案例区标签 | "成功案例" |
| CASES_TITLE | 案例区标题 | "他们选择了我们" |
| CASES_DESC | 案例区副标题 | "..." |
| CASE1~3_TITLE | 案例标题 | "某零售集团改造" |
| CASE1~3_DESC | 案例描述 | "..." |
| CONTACT_TAG | 联系区标签 | "联系我们" |
| CONTACT_TITLE | 联系区标题 | "开启合作" |
| CONTACT_DESC | 联系区副标题 | "..." |
| FOOTER_DESC | Footer 品牌描述 | "..." |
| YEAR | 版权年份（自动注入当前年） | "2026" |

## 注意事项

- HERO_TITLE 支持 HTML，可用 `span.highlight` 包裹关键词使其显示为主品牌色（generate_site.py 会原样写入 HTML，配置时直接填入含 HTML 的字符串即可）
- 网站为纯静态文件，无需后端，可直接部署到任何静态托管（GitHub Pages、Vercel、阿里云 OSS 等）
- 联系表单仅有前端演示效果，实际发送邮件需接入后端或第三方服务（如 Formspree）
- 如需添加更多板块（团队介绍、价格表、博客等），可在 index.html 中新增 section，在 styles.css 中追加样式
