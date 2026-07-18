#!/usr/bin/env python3
"""
书籍下载脚本 - 从Anna's Archive下载书籍
"""

import argparse
import json
import sys
import os
import urllib.request
import urllib.parse


def download_file(url: str, output_path: str, chunk_size: int = 8192) -> bool:
    """
    下载文件

    Args:
        url: 下载URL
        output_path: 保存路径
        chunk_size: 分块大小

    Returns:
        是否成功
    """
    try:
        print(f"开始下载: {url}")
        print(f"保存到: {output_path}")

        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            }
        )

        with urllib.request.urlopen(req, timeout=300) as response:
            total_size = int(response.headers.get("Content-Length", 0))
            downloaded = 0

            with open(output_path, "wb") as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)

                    if total_size > 0:
                        percent = (downloaded / total_size) * 100
                        print(f"\r下载进度: {percent:.1f}%", end="", flush=True)

        print(f"\n下载完成!")
        return True

    except Exception as e:
        print(f"\n下载失败: {e}", file=sys.stderr)
        if os.path.exists(output_path):
            os.remove(output_path)
        return False


def get_download_url(path: str, api_base: str = "https://api.annas-archive.org/api/v1") -> str:
    """
    获取下载URL

    Args:
        path: 书籍路径
        api_base: API基础URL

    Returns:
        下载URL
    """
    try:
        url = f"{api_base}/download?path={urllib.parse.quote(path)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})

        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))

            # 尝试获取下载链接
            if "download" in data:
                return data["download"].get("url", "")
            elif "cdn" in data:
                return data["cdn"]
            elif "url" in data:
                return data["url"]

        return ""

    except Exception as e:
        print(f"获取下载链接失败: {e}", file=sys.stderr)
        return ""


def download_by_search(
    query: str,
    output_dir: str = "~/Downloads/books",
    ext: str = "pdf",
    lang: str = None
) -> str:
    """
    搜索并下载书籍

    Args:
        query: 搜索关键词
        output_dir: 输出目录
        ext: 文件格式
        lang: 语言

    Returns:
        下载的文件路径
    """
    # 搜索书籍
    print(f"搜索书籍: {query}")

    # 使用搜索API
    import subprocess
    search_cmd = [
        "python3",
        "/Users/zhuxiaodong/.workbuddy/skills/book-downloader/scripts/search_books.py",
        query
    ]
    if lang:
        search_cmd.extend(["--lang", lang])
    if ext:
        search_cmd.extend(["--ext", ext])

    result = subprocess.run(search_cmd, capture_output=True, text=True)
    print(result.stdout)

    # 读取搜索结果
    results_file = "/tmp/book_search_results.json"
    if not os.path.exists(results_file):
        print("搜索结果文件不存在", file=sys.stderr)
        return ""

    with open(results_file, "r", encoding="utf-8") as f:
        results = json.load(f)

    if not results:
        print("未找到可下载的书籍", file=sys.stderr)
        return ""

    # 选择第一个结果
    book = results[0]
    title = book.get("title", "unknown")
    files = book.get("files", [])

    if not files:
        print("该书籍没有可下载的文件", file=sys.stderr)
        return ""

    # 优先选择PDF
    pdf_file = None
    for f in files:
        if "pdf" in f.get("format", "").lower():
            pdf_file = f
            break

    if not pdf_file:
        pdf_file = files[0]

    # 创建输出目录
    output_dir = os.path.expanduser(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # 生成文件名
    safe_title = "".join(c for c in title if c.isalnum() or c in " -_").strip()
    filename = f"{safe_title}.pdf"
    output_path = os.path.join(output_dir, filename)

    # 获取下载链接并下载
    path = pdf_file.get("path", "")
    if path:
        download_url = get_download_url(path)
        if download_url:
            if download_file(download_url, output_path):
                return output_path
        else:
            print("无法获取下载链接，请手动下载", file=sys.stderr)
    else:
        print("书籍信息中没有下载路径", file=sys.stderr)

    return ""


def main():
    parser = argparse.ArgumentParser(description="下载书籍")
    parser.add_argument("--query", "-q", help="搜索关键词")
    parser.add_argument("--path", "-p", help="书籍在Anna's Archive的路径")
    parser.add_argument("--url", "-u", help="直接下载URL")
    parser.add_argument("--output", "-o", default="~/Downloads/books", help="输出目录")
    parser.add_argument("--lang", "-l", help="语言筛选")
    parser.add_argument("--ext", "-e", default="pdf", help="文件格式")

    args = parser.parse_args()

    output_dir = os.path.expanduser(args.output)
    os.makedirs(output_dir, exist_ok=True)

    if args.url:
        # 直接下载URL
        filename = os.path.basename(args.url.split("?")[0])
        output_path = os.path.join(output_dir, filename)
        download_file(args.url, output_path)

    elif args.path:
        # 通过路径下载
        download_url = get_download_url(args.path)
        if download_url:
            filename = f"{args.path.split('/')[-1]}.pdf"
            output_path = os.path.join(output_dir, filename)
            download_file(download_url, output_path)
        else:
            print("无法获取下载链接", file=sys.stderr)
            sys.exit(1)

    elif args.query:
        # 搜索并下载
        result = download_by_search(args.query, args.output, args.ext, args.lang)
        if result:
            print(f"\n书籍已保存到: {result}")
        else:
            sys.exit(1)

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
