#!/usr/bin/env python3
"""
PDF 转 TXT 脚本 v2
策略：
  1. 优先用 PyMuPDF 直接提取嵌入文字（快，准）
  2. 若某页文字量太少（扫描件/图片页），自动转 OCR（pytesseract + pdf2image）
  3. 两种结果合并输出到同一 .txt 文件

OCR 依赖（首次使用需安装）：
  brew install tesseract tesseract-lang poppler
  pip3 install pytesseract pdf2image pymupdf
"""

import argparse
import os
import subprocess
import sys
from typing import Optional


# 每页文字量低于此字符数，认为是图片页，触发 OCR
OCR_THRESHOLD = 50


# ── 工具函数 ──────────────────────────────────────────────


def _check_and_install(package: str, import_name: str = None) -> bool:
    """尝试 import；失败则自动 pip install"""
    import_name = import_name or package
    try:
        __import__(import_name)
        return True
    except ImportError:
        print(f"  📦 安装 {package}...")
        ret = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", package],
            capture_output=True,
        )
        if ret.returncode == 0:
            try:
                __import__(import_name)
                return True
            except ImportError:
                pass
        print(f"  ⚠️  {package} 安装失败，请手动执行: pip3 install {package}")
        return False


def _check_tesseract() -> bool:
    """检查 tesseract 是否安装，以及中文语言包"""
    try:
        result = subprocess.run(
            ["tesseract", "--list-langs"],
            capture_output=True, text=True, timeout=5
        )
        langs = result.stdout + result.stderr
        has_chi = "chi_sim" in langs or "chi_tra" in langs
        if not has_chi:
            print("  ⚠️  未找到 Tesseract 中文语言包")
            print("  👉 安装方法: brew install tesseract-lang")
            print("     或: brew install tesseract && brew install --cask font-noto-sans-cjk")
        return True
    except FileNotFoundError:
        print("  ⚠️  未找到 tesseract，OCR 不可用")
        print("  👉 安装方法: brew install tesseract tesseract-lang")
        return False


# ── 核心提取函数 ──────────────────────────────────────────


def _extract_text_pymupdf(pdf_path: str, start_page: int = 1, end_page: int = None) -> dict:
    """
    用 PyMuPDF 提取文字
    返回 {page_num: text_str}，文字少的页标记为 image_page
    """
    import fitz

    doc = fitz.open(pdf_path)
    total = len(doc)
    if end_page is None or end_page > total:
        end_page = total

    pages = {}
    image_pages = []

    print(f"\n  PyMuPDF 提取文字，共 {total} 页，处理 {start_page}~{end_page} 页...")

    for pn in range(start_page - 1, end_page):
        page = doc[pn]
        text = page.get_text("text")
        pages[pn + 1] = text

        if len(text.strip()) < OCR_THRESHOLD:
            image_pages.append(pn + 1)

        if (pn + 1) % 50 == 0:
            print(f"    ... 已处理 {pn + 1}/{end_page} 页")

    doc.close()

    print(f"  ✅ 文字页: {end_page - start_page + 1 - len(image_pages)} 页  | 图片/空白页: {len(image_pages)} 页")
    return {"pages": pages, "image_pages": image_pages, "total": total}


def _ocr_pages(pdf_path: str, page_nums: list, lang: str = "chi_sim+eng", dpi: int = 200) -> dict:
    """
    对指定页码列表执行 OCR
    返回 {page_num: ocr_text}
    """
    if not page_nums:
        return {}

    if not _check_tesseract():
        return {}

    if not _check_and_install("pdf2image"):
        return {}

    if not _check_and_install("pytesseract"):
        return {}

    from pdf2image import convert_from_path
    import pytesseract

    print(f"\n  OCR 识别 {len(page_nums)} 个图片页 (lang={lang}, dpi={dpi})...")
    print(f"  📌 页码: {page_nums[:20]}{'...' if len(page_nums) > 20 else ''}")

    # 批量转换指定页为图像
    # first_page/last_page 从 1 开始
    ocr_results = {}
    for pn in page_nums:
        try:
            images = convert_from_path(
                pdf_path, dpi=dpi,
                first_page=pn, last_page=pn
            )
            if images:
                text = pytesseract.image_to_string(images[0], lang=lang)
                ocr_results[pn] = text
                print(f"    ✅ 第 {pn} 页 OCR 完成，{len(text)} 字符")
        except Exception as e:
            print(f"    ⚠️  第 {pn} 页 OCR 失败: {e}")
            ocr_results[pn] = f"[OCR失败: {e}]"

    return ocr_results


# ── 主转换函数 ────────────────────────────────────────────


def pdf_to_txt(
    pdf_path: str,
    output_path: str = None,
    start_page: int = 1,
    end_page: int = None,
    method: str = "auto",
    ocr_lang: str = "chi_sim+eng",
    ocr_dpi: int = 200,
) -> bool:
    """
    PDF 转 TXT 主函数

    method:
      auto      - 智能双路径（推荐）：先直提，图片页自动 OCR
      pymupdf   - 仅 PyMuPDF 直提文字（不含 OCR）
      ocr       - 全页 OCR（适合纯扫描件，慢）
      pdftotext - 使用系统 pdftotext 命令
    """
    if not os.path.exists(pdf_path):
        print(f"文件不存在: {pdf_path}")
        return False

    if not output_path:
        output_path = os.path.splitext(pdf_path)[0] + ".txt"

    print(f"\n{'='*60}")
    print(f"📄 PDF 转 TXT")
    print(f"   输入: {pdf_path}")
    print(f"   输出: {output_path}")
    print(f"   方法: {method}")
    print(f"{'='*60}")

    # ─── pdftotext 模式 ───────────────────────────────────
    if method == "pdftotext":
        try:
            result = subprocess.run(
                ["pdftotext", "-layout", pdf_path, output_path],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                print(f"✅ 转换完成! 保存到: {output_path}")
                return True
            else:
                print(f"pdftotext 失败: {result.stderr}")
                return False
        except FileNotFoundError:
            print("pdftotext 未安装，请运行: brew install poppler")
            return False

    # ─── 确认 PyMuPDF 可用 ───────────────────────────────
    if not _check_and_install("pymupdf", "fitz"):
        return False

    # ─── 全量 OCR 模式 ────────────────────────────────────
    if method == "ocr":
        import fitz
        doc = fitz.open(pdf_path)
        total = len(doc)
        doc.close()
        if end_page is None:
            end_page = total

        all_pages = list(range(start_page, end_page + 1))
        ocr_results = _ocr_pages(pdf_path, all_pages, ocr_lang, ocr_dpi)
        _write_output(output_path, {}, ocr_results, start_page, end_page)
        print(f"\n✅ OCR 转换完成! 保存到: {output_path}")
        return True

    # ─── pymupdf 仅直提模式 ───────────────────────────────
    if method == "pymupdf":
        extract = _extract_text_pymupdf(pdf_path, start_page, end_page)
        _write_output(output_path, extract["pages"], {}, start_page,
                      end_page or extract["total"])
        print(f"\n✅ 转换完成! 保存到: {output_path}")
        return True

    # ─── auto：智能双路径（默认）─────────────────────────
    extract = _extract_text_pymupdf(pdf_path, start_page, end_page)
    image_pages = extract["image_pages"]
    actual_end = end_page or extract["total"]

    ocr_results = {}
    if image_pages:
        print(f"\n  检测到 {len(image_pages)} 个图片/空白页，启动 OCR 补充...")
        ocr_results = _ocr_pages(pdf_path, image_pages, ocr_lang, ocr_dpi)
    else:
        print("  所有页面均有嵌入文字，无需 OCR")

    _write_output(output_path, extract["pages"], ocr_results, start_page, actual_end)

    # 统计
    txt_size = os.path.getsize(output_path)
    print(f"\n{'='*60}")
    print(f"✅ 转换完成!")
    print(f"   输出文件: {output_path}")
    print(f"   文件大小: {txt_size/1024:.1f} KB")
    print(f"   OCR 页数: {len(ocr_results)}")
    print(f"{'='*60}")
    return True


def _write_output(
    output_path: str,
    pages: dict,
    ocr_results: dict,
    start_page: int,
    end_page: int,
):
    """合并直提文字和 OCR 结果，写入文件"""
    lines = []
    for pn in range(start_page, end_page + 1):
        # OCR 优先（对图片页有效）
        if pn in ocr_results and ocr_results[pn].strip():
            lines.append(f"=== 第 {pn} 页 [OCR] ===")
            lines.append(ocr_results[pn].strip())
        elif pn in pages and pages[pn].strip():
            lines.append(f"=== 第 {pn} 页 ===")
            lines.append(pages[pn].strip())
        else:
            lines.append(f"=== 第 {pn} 页 [空] ===")
        lines.append("")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# ── CLI ───────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="PDF 转 TXT（支持扫描件 OCR）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 自动模式（推荐）：文字版直提，扫描版自动 OCR
  python3 pdf_to_txt.py book.pdf

  # 仅直提（快速）
  python3 pdf_to_txt.py book.pdf --method pymupdf

  # 全量 OCR（纯扫描件）
  python3 pdf_to_txt.py book.pdf --method ocr --ocr-lang chi_sim+eng

  # 只转第 1-50 页
  python3 pdf_to_txt.py book.pdf --start 1 --end 50
        """
    )
    parser.add_argument("pdf", help="PDF 文件路径")
    parser.add_argument("--output", "-o", help="输出 TXT 路径")
    parser.add_argument(
        "--method", "-m",
        choices=["auto", "pymupdf", "pdftotext", "ocr"],
        default="auto",
        help="转换方法（默认: auto）"
    )
    parser.add_argument("--start", "-s", type=int, default=1, help="起始页（默认: 1）")
    parser.add_argument("--end", "-e", type=int, help="结束页（默认: 最后一页）")
    parser.add_argument(
        "--ocr-lang",
        default="chi_sim+eng",
        help="OCR 语言（默认: chi_sim+eng）"
    )
    parser.add_argument(
        "--ocr-dpi",
        type=int, default=200,
        help="OCR 渲染 DPI，越高越清晰（默认: 200）"
    )

    args = parser.parse_args()

    success = pdf_to_txt(
        args.pdf,
        output_path=args.output,
        start_page=args.start,
        end_page=args.end,
        method=args.method,
        ocr_lang=args.ocr_lang,
        ocr_dpi=args.ocr_dpi,
    )

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
