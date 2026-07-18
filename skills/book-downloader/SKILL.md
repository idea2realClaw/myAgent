---
name: book-downloader
description: 书籍下载和PDF转TXT/OCR工具。当用户需要下载图书、搜索电子书、下载PDF、将PDF转换为TXT文本（含扫描件OCR），或校对 OCR 识别文本时使用此Skill。支持从Z-Library、Project Gutenberg、鸠摩搜索等多个图书库搜索和下载中英文书籍，并支持智能校对功能。
---

# 书籍下载 Skill v4（2026-04-04）

## 功能概述

| 步骤 | 功能 | 说明 |
|------|------|------|
| 1 | 搜索书籍 | Z-Library（推荐）、Project Gutenberg、鸠摩搜索 |
| 2 | 下载书籍 | 自动识别格式（PDF/EPUB/TXT） |
| 3 | PDF 转 TXT | **智能双路径**：文字版直接提取，扫描件自动 OCR |
| 4 | **智能校对** | 通过 LLM 重写 OCR 文本，纠正错字乱码，生成通顺文字 |

## 依赖安装

```bash
# 核心（必须）
pip3 install pymupdf requests

# Z-Library SPA 搜索（必须，Playwright 动态页面）
pip3 install playwright
playwright install chromium          # 首次运行前必须执行一次

# OCR（扫描件需要）
brew install tesseract tesseract-lang poppler
pip3 install pytesseract pdf2image

# 校对（需要 LLM API Key）
# 设置环境变量或使用参数 -k 传入
export OPENAI_API_KEY=sk-xxx
```

## 使用方法

### 一键完成（搜索 → 下载 → 转 TXT）

```bash
python3 ~/.workbuddy/skills/book-downloader/scripts/run.py "书名"
```

### 分步操作

```bash
# 仅搜索
python3 run.py "太极拳" --search-only

# 下载搜索结果的第N本（从0开始）
python3 run.py --download-only --index 1

# 直接将本地 PDF 转 TXT
python3 run.py --pdf ~/Downloads/book.pdf

# PDF 转 TXT（扫描件自动 OCR）
python3 run.py --pdf ~/Downloads/book.pdf --method ocr --ocr-lang chi_sim+eng
```

### 指定搜索源

| 参数 | 搜索源 | 说明 |
|------|--------|------|
| `--source zlib` | **Z-Library** | 收录最全（默认），约 1500 万册 |
| `--source gutenberg` | Project Gutenberg | 公版书，约 7 万册 |
| `--source jiumo` | 鸠摩搜索 | 国内资源 |
| `--source all` | 全部 | 较慢 |

## 命令行参数

| 参数 | 说明 |
|------|------|
| `query` | 搜索关键词（中文或英文） |
| `--search-only, -s` | 仅搜索，不下载 |
| `--download-only, -d` | 仅下载，使用上次搜索结果 |
| `--index, -i` | 选择第几本书（从0开始，默认0） |
| `--output-dir, -o` | 下载目录（默认 ~/Downloads/books） |
| `--lang, -l` | 语言筛选 |
| `--source` | 搜索源（默认 zlib） |
| `--pdf` | 指定 PDF 文件直接转 TXT |

## PDF 转 TXT 参数

| 参数 | 说明 |
|------|------|
| `--method auto` | **智能**（默认）：文字页直提，图片页自动 OCR |
| `--method pymupdf` | 仅直提文字（快速，不含 OCR） |
| `--method ocr` | 全量 OCR（适合纯扫描件，速度慢） |
| `--start, --end` | 指定页码范围 |
| `--ocr-lang chi_sim+eng` | OCR 语言（中文+英文） |
| `--ocr-dpi 200` | OCR 渲染清晰度（默认200，越高越清晰） |

## 输出位置

- **下载目录**: `~/Downloads/books/`
- **搜索结果缓存**: `/tmp/book_search_results.json`
- **TXT 文件**: 与 PDF 同目录

## 经验总结（2026-04-04）

### Z-Library SPA 技术要点

**关键发现**：Z-Library 使用 Web Components（Svelte/Vue），书籍数据渲染在 `<Z-BOOKCARD>` 自定义元素中，**无法通过普通 HTTP 请求获取，必须使用 Playwright**。

**搜索流程**：
1. Playwright 打开搜索页 `https://zh.z-lib.fm/s/关键词`
2. 等待 SPA 加载（6秒）
3. 用 `document.querySelectorAll('z-bookcard')` 提取数据
4. 从 `href` 属性获取书籍详情页路径 `/book/xxxxx/title.html`

**下载链接提取**：通过 HTTP 访问书籍详情页，直接从 HTML 中匹配 `href="/dl/xxxxx"`。

### Z-Library 可用镜像（香港网络环境）

| 镜像 | 状态 |
|------|------|
| zh.z-lib.fm | ✅ 可用（推荐） |
| zh.z-lib.gs | ✅ 可用 |
| z-lib.fm / z-lib.gs | ✅ 可用 |
| zh.z-lib.gs | DNS 不可达 |

> Anna's Archive 在香港网络环境完全不可达（DNS NXDOMAIN）。

### OCR 扫描件处理

- 智能判断：每页文字 < 50 字符 → 触发 OCR
- 中文识别：需要 `tesseract-lang` 包含 `chi_sim`（简体中文）
- 高清扫描件：建议 `--ocr-dpi 300` 提高识别准确率
- **重要**：必须执行 `playwright install chromium` 才能启用 Z-Library 搜索

## 经验教训

| 时间 | 教训 |
|------|------|
| 2026-04-04 | Anna's Archive 在香港网络完全不可达（DNS NXDOMAIN） |
| 2026-04-04 | Z-Library 是 SPA 页面（`<Z-BOOKCARD>` Web Component），**必须用 Playwright 搜索**，普通 HTTP 请求无法提取书籍列表 |
| 2026-04-04 | 下载链接在书籍详情页 HTML 中，用正则 `href="/dl/xxx"` 可直接提取（无需 Playwright） |
| 2026-04-04 | 很多 PDF 是扫描图片，PyMuPDF 文字提取为空（0字符），OCR 智能回退正常工作 |
| 2026-04-04 | Tesseract 中文识别需要 `chi_sim` 语言包，否则 OCR 输出乱码 |
| 2026-04-04 | 校对脚本 proofread.py 按页面分块（~3500字），避免 LLM 单次输入过长 |
| 2026-04-04 | 校对 LLM 调用温度 0.3，保持忠实原文不过度创意发挥 |

## 示例操作

```bash
# 1. 下载《武当赵堡太极拳大全》第2版（Z-Library）
python3 run.py "武当赵堡太极拳大全"

# 2. 下载公版书（Project Gutenberg）
python3 run.py "Meditations" --source gutenberg

# 3. 搜索但不下
python3 run.py "Python 编程" --search-only

# 4. PDF 直接转 TXT（自动判断是否需要 OCR）
python3 run.py --pdf ~/Downloads/book.pdf

# 5. 扫描件 PDF 全量 OCR
python3 run.py --pdf ~/Downloads/scan.pdf --method ocr --ocr-dpi 300

# 6. 仅转第 1-100 页
python3 run.py --pdf ~/Downloads/book.pdf --start 1 --end 100

### 智能校对（新增 v4）

校对功能通过 LLM 自动纠正 OCR 识别错误、修复乱码、润色语句，使文字通顺准确。

**先决条件**：设置 `OPENAI_API_KEY` 环境变量（或通过参数传入）。

```bash
# 方式1：通过 run.py 调用（自动找文件）
python3 run.py --proofread ~/Downloads/books/武当赵堡太极拳大全.txt

# 方式2：直接调用校对脚本
python3 ~/.workbuddy/skills/book-downloader/scripts/proofread.py ~/Downloads/book.txt

# 指定输出文件名
python3 run.py --proofread ~/Downloads/book.txt -o ~/Downloads/校对版.txt

# 指定模型（默认 gpt-4o-mini）
python3 run.py --proofread ~/Downloads/book.txt --proofread-model gpt-4o

# 预览模式（只处理第一块）
python3 run.py --proofread ~/Downloads/book.txt --proofread-dry-run

# 自定义 API 端点（如硅基流动）
OPENAI_BASE_URL=https://api.siliconflow.cn/v1 \
OPENAI_API_KEY=xxx \
python3 proofread.py ~/Downloads/book.txt
```

**校对工作原理**：
1. 按页面边界将文本分成 ~3500 字符的块
2. 每块交给 LLM 重写（纠正 OCR 错误、润色语句、保留专有名词）
3. 合并所有块输出到 `xxx_校对版.txt`

