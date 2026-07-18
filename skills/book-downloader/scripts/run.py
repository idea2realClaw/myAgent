#!/usr/bin/env python3
"""
书籍下载主脚本 v4（2026-04-04）
新增 Z-Library 支持（zh.z-lib.fm）+ 智能校对功能：

用法：
  python3 run.py "书名"                    # 搜索 → 下载 → 转 TXT（全自动）
  python3 run.py "书名" --search-only       # 仅搜索
  python3 run.py "书名" --download-only    # 下载
  python3 run.py --pdf xxx.pdf              # 直接转 TXT
  python3 run.py --proofread xxx.txt        # 校对 TXT 文件
  python3 run.py --proofread xxx.txt -o out.txt  # 校对并指定输出
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

DEFAULT_DOWNLOAD_DIR = "~/Downloads/books"

# ── 导入子模块 ─────────────────────────────────────────────
_script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _script_dir)

try:
    from zlib_downloader import search_zlib, download_zlib_book, ZLIB_MIRRORS
    HAS_ZLIB = True
except ImportError as e:
    HAS_ZLIB = False
    print(f"⚠️  Z-Library 模块加载失败: {e}，将仅使用备用源")


# ── 原有搜索函数（备用）────────────────────────────────────

def search_gutenberg(query: str) -> list:
    try:
        url = f"https://gutendex.com/books/?search={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        results = []
        for item in data.get("results", [])[:20]:
            book = {
                "title": item.get("title", "Unknown"),
                "author": (item.get("authors", [{}])[0].get("name", "Unknown")
                           if item.get("authors") else "Unknown"),
                "year": "", "publisher": "Project Gutenberg",
                "source": "Project Gutenberg", "files": []
            }
            fmts = item.get("formats", {})
            for fmt, url in fmts.items():
                if "pdf" in fmt:
                    book["files"] = [{"format": "PDF", "size": 0, "url": url, "path": ""}]
                    break
            if not book["files"]:
                for fmt, url in fmts.items():
                    if "plain" in fmt or "utf-8" in fmt:
                        book["files"] = [{"format": "TXT", "size": 0, "url": url, "path": ""}]
                        break
            if book["files"]:
                results.append(book)
        return results
    except Exception as e:
        print(f"  Gutenberg 搜索失败: {e}")
        return []


def search_jiumo(query: str) -> list:
    try:
        url = f"https://www.jiumodiary.com/ajax.php?wd={urllib.parse.quote(query)}&type=all"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.jiumodiary.com/"
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        results = []
        for item in data.get("data", [])[:20]:
            book = {
                "title": item.get("name", "Unknown"),
                "author": item.get("author", "Unknown"),
                "year": "", "publisher": "",
                "source": "鸠摩搜索", "files": []
            }
            for link in item.get("dl", []):
                if "pdf" in link.lower():
                    book["files"] = [{"format": "PDF", "size": 0, "url": link, "path": ""}]
                    break
            if not book["files"] and item.get("dl"):
                book["files"] = [{"format": "多格式", "size": 0,
                                  "url": item["dl"][0], "path": ""}]
            if book["files"]:
                results.append(book)
        return results
    except Exception as e:
        print(f"  鸠摩搜索失败: {e}")
        return []


# ── 搜索入口 ───────────────────────────────────────────────

def search_books(query: str, lang: str = None, source: str = "zlib") -> list:
    """
    source: zlib | gutenberg | jiumo | all
    """
    print(f"\n{'='*60}")
    print(f"搜索: {query}")
    if lang:
        print(f"语言: {lang}")
    print(f"源: {source}")
    print(f"{'='*60}")

    all_results = []

    # ── Z-Library（SPA 页面，需 Playwright）──────────────
    if source in ("zlib", "all"):
        if HAS_ZLIB:
            print("\n[1/3] 🔍 Z-Library (Playwright SPA)...")
            results = search_zlib(query, lang)
            if results:
                print(f"    找到 {len(results)} 本")
                all_results.extend(results)
            else:
                print("    无结果或网络不可达")
        else:
            print("\n[1/3] ⏭ Z-Library 模块未加载")

    # ── Project Gutenberg ─────────────────────────────────
    if source in ("gutenberg", "all"):
        print("\n[2/3] 🔍 Project Gutenberg...")
        results = search_gutenberg(query)
        if results:
            print(f"    找到 {len(results)} 本")
            all_results.extend(results)
        else:
            print("    无结果")

    # ── 鸠摩搜索 ───────────────────────────────────────────
    if source in ("jiumo", "all"):
        print("\n[3/3] 🔍 鸠摩搜索...")
        results = search_jiumo(query)
        if results:
            print(f"    找到 {len(results)} 本")
            all_results.extend(results)
        else:
            print("    无结果")

    # ── 去重 & 显示 ────────────────────────────────────────
    seen = set()
    unique = []
    for b in all_results:
        key = b["title"].lower()[:60]
        if key not in seen:
            seen.add(key)
            unique.append(b)

    if unique:
        print(f"\n{'='*60}")
        print(f"共 {len(unique)} 本:\n")
        for i, b in enumerate(unique[:30]):
            src_tag = f"[{b.get('source', 'unknown')[:20]}]"
            print(f"  {i}. {src_tag} {b['title']}")
            if b.get("author") and b["author"] != "Unknown":
                print(f"       作者: {b['author']}")
            if b.get("year"):
                print(f"       年份: {b['year']}")
            print()
    else:
        print("\n未找到任何结果")

    # 缓存到临时文件
    cache = "/tmp/book_search_results.json"
    with open(cache, "w", encoding="utf-8") as f:
        json.dump(unique, f, ensure_ascii=False, indent=2)

    return unique


# ── 下载 ──────────────────────────────────────────────────

def download_book(book: dict, output_dir: str = DEFAULT_DOWNLOAD_DIR) -> str:
    output_dir = os.path.expanduser(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    src = book.get("source", "")

    # Z-Library
    if "Z-Library" in src or HAS_ZLIB and book.get("_base"):
        return download_zlib_book(book, output_dir)

    # Gutenberg / 鸠摩：通用 URL 下载
    for f in book.get("files", []):
        url = f.get("url", "")
        if url:
            return _download_url(url, book.get("title", "book"), output_dir)

    print("无可用下载链接")
    return ""


def _download_url(url: str, title: str, output_dir: str) -> str:
    """通用 URL 下载"""
    safe = "".join(c for c in title[:50] if c.isalnum() or c in " -_").strip()
    ext = "pdf" if "pdf" in url.lower() else "txt"
    path = os.path.join(output_dir, f"{safe}.{ext}")

    print(f"\n⬇️  下载: {url[:80]}...")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            size = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            with open(path, "wb") as f:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if size > 0:
                        pct = downloaded / size * 100
                        print(f"\r  进度: {pct:.1f}%", end="", flush=True)
            print(f"\n  ✅ 完成: {downloaded/1024/1024:.1f} MB")
            return path
    except Exception as e:
        print(f"\n  下载失败: {e}")
        return ""


# ── PDF 转 TXT ────────────────────────────────────────────

def convert_pdf_to_txt(pdf_path: str, output_path: str = None) -> str:
    if not os.path.exists(pdf_path):
        print(f"文件不存在: {pdf_path}")
        return ""

    if not output_path:
        output_path = os.path.splitext(pdf_path)[0] + ".txt"

    print(f"\n{'='*60}")
    print(f"📝 PDF 转 TXT: {pdf_path}")
    print(f"   方法: auto（文字页直提 + 图片页 OCR）")
    print(f"{'='*60}")

    # 复用 pdf_to_txt 模块
    from pdf_to_txt import pdf_to_txt as _do_convert
    success = _do_convert(
        pdf_path,
        output_path=output_path,
        method="auto",
        ocr_lang="chi_sim+eng",
    )
    return output_path if success else ""


# ── 校对入口 ───────────────────────────────────────────────

def proofread_txt(input_path: str, output_path: str = "", **kwargs) -> str:
    """调用 proofread 模块进行校对"""
    from proofread import proofread_file
    return proofread_file(input_path, output_path, **kwargs)


# ── 主入口 ────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="书籍下载 v4（Z-Library + Gutenberg + 鸠摩 + 校对）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("query", nargs="?", help="搜索关键词")
    parser.add_argument("--search-only", "-s", action="store_true", help="仅搜索")
    parser.add_argument("--download-only", "-d", action="store_true", help="仅下载")
    parser.add_argument("--index", "-i", type=int, default=0, help="选择第几本（从0开始）")
    parser.add_argument("--output-dir", "-o", default=DEFAULT_DOWNLOAD_DIR, help="下载目录")
    parser.add_argument("--lang", "-l", help="语言筛选")
    parser.add_argument(
        "--source",
        choices=["zlib", "gutenberg", "jiumo", "all"],
        default="zlib",
        help="搜索源（默认: zlib）"
    )
    parser.add_argument("--pdf", help="直接转 TXT（指定 PDF 路径）")
    # ── 校对参数 ──────────────────────────────────────────
    parser.add_argument("--proofread", metavar="FILE",
                        help="校对 OCR 文本文件（.txt）")
    parser.add_argument("--proofread-output", metavar="FILE",
                        help="校对输出文件路径")
    parser.add_argument("--proofread-api-key", metavar="KEY",
                        help="LLM API Key（也可设置环境变量 OPENAI_API_KEY）")
    parser.add_argument("--proofread-model", metavar="MODEL", default="gpt-4o-mini",
                        help="LLM 模型（默认: gpt-4o-mini）")
    parser.add_argument("--proofread-dry-run", action="store_true",
                        help="校对预览模式（只处理第一块）")

    args = parser.parse_args()

    # ── 校对模式 ───────────────────────────────────────────
    if args.proofread:
        import os as _os
        if not _os.path.exists(args.proofread):
            print(f"❌ 文件不存在: {args.proofread}")
            sys.exit(1)
        print(f"\n{'='*60}")
        print(f"✏️  智能校对模式")
        print(f"   输入: {args.proofread}")
        if args.proofread_output:
            print(f"   输出: {args.proofread_output}")
        print(f"   模型: {args.proofread_model}")
        print(f"{'='*60}")
        try:
            output = proofread_txt(
                input_path=args.proofread,
                output_path=args.proofread_output or "",
                api_key=args.proofread_api_key or "",
                model=args.proofread_model or "gpt-4o-mini",
                dry_run=args.proofread_dry_run,
            )
            if not args.proofread_dry_run:
                print(f"\n🎉 校对完成: {output}")
        except ValueError as e:
            print(f"❌ {e}")
            sys.exit(1)
        except RuntimeError as e:
            print(f"❌ {e}")
            sys.exit(1)
        except KeyboardInterrupt:
            print("\n⚠️  已中断")
            sys.exit(130)
        return

    # ── 直接转 TXT ─────────────────────────────────────────
    if args.pdf:
        result = convert_pdf_to_txt(args.pdf)
        if result:
            print(f"\n✨ 完成: {result}")
        else:
            sys.exit(1)
        return

    # ── 仅搜索 ─────────────────────────────────────────────
    if args.search_only:
        if not args.query:
            print("请提供搜索关键词")
            sys.exit(1)
        results = search_books(args.query, args.lang, args.source)
        if results:
            print(f"\n共 {len(results)} 本，已缓存到 /tmp/book_search_results.json")
        return

    # ── 仅下载 ─────────────────────────────────────────────
    if args.download_only:
        cache = "/tmp/book_search_results.json"
        if not os.path.exists(cache):
            print("没有搜索记录，请先搜索")
            sys.exit(1)
        with open(cache, "r", encoding="utf-8") as f:
            results = json.load(f)
        book = results[args.index] if args.index < len(results) else results[0]
        pdf_path = download_book(book, args.output_dir)
        if pdf_path:
            txt = convert_pdf_to_txt(pdf_path)
            print(f"\n{'='*60}")
            print(f"✨ 完成")
            print(f"   PDF: {pdf_path}")
            if txt:
                print(f"   TXT: {txt}")
            print(f"{'='*60}")
        return

    # ── 全流程 ─────────────────────────────────────────────
    if not args.query:
        parser.print_help()
        print("\n示例:")
        print("  python3 run.py 太极拳")
        print("  python3 run.py 沉思录 --source gutenberg")
        print("  python3 run.py Python --search-only")
        print("  python3 run.py --pdf ~/Downloads/book.pdf")
        print("  python3 run.py --proofread ~/Downloads/book.txt")
        print("  python3 run.py --proofread ~/Downloads/book.txt -o ~/校对本.txt")
        sys.exit(1)

    results = search_books(args.query, args.lang, args.source)
    if not results:
        print("\n⚠️  未找到书籍，建议尝试其他搜索源:")
        print("  --source gutenberg   (公版书)")
        print("  --source jiumo       (国内资源)")
        print("  --source all         (全部)")
        sys.exit(1)

    book = results[args.index]
    print(f"\n⬇️  下载第 {args.index} 本: {book['title']}")
    pdf_path = download_book(book, args.output_dir)

    if pdf_path and os.path.exists(pdf_path):
        txt_path = convert_pdf_to_txt(pdf_path)
    else:
        txt_path = None

    print(f"\n{'='*60}")
    print(f"✨ 完成")
    if pdf_path and os.path.exists(pdf_path):
        print(f"   PDF: {pdf_path}")
    if txt_path:
        print(f"   TXT: {txt_path}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
