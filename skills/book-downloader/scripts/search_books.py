#!/usr/bin/env python3
"""
书籍搜索脚本 - 使用Anna's Archive搜索书籍
"""

import argparse
import json
import sys
from typing import Optional, List, Dict, Any
import urllib.request
import urllib.parse


def search_annas_archive(
    query: str,
    lang: Optional[str] = None,
    ext: Optional[str] = None,
    api_base: str = "https://api.annas-archive.org/api/v1"
) -> List[Dict[str, Any]]:
    """
    搜索Anna's Archive书籍

    Args:
        query: 搜索关键词
        lang: 语言代码（如 'en', 'zh'）
        ext: 文件扩展名（如 'pdf', 'epub'）
        api_base: API基础URL

    Returns:
        搜索结果列表
    """
    # 构建搜索URL
    params = {"text": query}
    if lang:
        params["languages"] = lang
    if ext:
        params["file_type"] = ext.upper()

    url = f"{api_base}/search/public/search-lit?" + urllib.parse.urlencode(params)

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))

        results = []
        # 解析搜索结果
        if "results" in data:
            for item in data["results"]:
                result = {
                    "title": item.get("title", "Unknown"),
                    "author": item.get("authors", ["Unknown"])[0] if item.get("authors") else "Unknown",
                    "year": item.get("year", ""),
                    "files": []
                }

                # 获取文件信息
                if "files" in item:
                    for f in item["files"]:
                        result["files"].append({
                            "format": f.get("format", ""),
                            "size": f.get("filesize", 0),
                            "md5": f.get("md5", ""),
                            "path": f.get("path", "")
                        })

                if result["files"]:
                    results.append(result)

        return results

    except Exception as e:
        print(f"搜索出错: {e}", file=sys.stderr)
        return []


def search_alternative(query: str, lang: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    备用搜索方法 - 直接抓取网页
    """
    try:
        # 使用Z-Library替代搜索
        url = f"https://1lib.sk/?q={urllib.parse.quote(query)}"
        if lang:
            url += f"&languages={lang}"

        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            }
        )

        with urllib.request.urlopen(req, timeout=30) as response:
            html = response.read().decode("utf-8")

        results = []
        # 简单解析HTML（实际使用时可能需要更复杂的解析）
        import re
        books = re.findall(r'href="(/book/\d+/[^"]+)"[^>]*>([^<]+)', html)

        for path, title in books[:20]:
            results.append({
                "title": title.strip(),
                "path": path,
                "files": [{"format": "PDF/EPUB", "size": 0, "path": path}]
            })

        return results

    except Exception as e:
        print(f"备用搜索出错: {e}", file=sys.stderr)
        return []


def format_results(results: List[Dict[str, Any]]) -> str:
    """格式化搜索结果"""
    if not results:
        return "未找到结果"

    output = []
    for i, book in enumerate(results, 1):
        title = book.get("title", "Unknown")
        author = book.get("author", "Unknown")
        year = book.get("year", "")
        formats = [f.get("format", "") for f in book.get("files", [])]

        output.append(f"{i}. {title}")
        output.append(f"   作者: {author}")
        if year:
            output.append(f"   年份: {year}")
        if formats:
            output.append(f"   格式: {', '.join(formats)}")
        output.append("")

    return "\n".join(output)


def main():
    parser = argparse.ArgumentParser(description="搜索书籍")
    parser.add_argument("query", help="搜索关键词")
    parser.add_argument("--lang", "-l", help="语言代码 (en, zh, etc.)")
    parser.add_argument("--ext", "-e", help="文件格式 (pdf, epub)")
    parser.add_argument("--api", help="Anna's Archive API地址")

    args = parser.parse_args()

    print(f"正在搜索: {args.query}")
    if args.lang:
        print(f"语言: {args.lang}")
    if args.ext:
        print(f"格式: {args.ext}")
    print()

    # 使用Anna's Archive搜索
    api_base = args.api or "https://api.annas-archive.org/api/v1"
    results = search_annas_archive(args.query, args.lang, args.ext, api_base)

    # 如果Anna's Archive没有结果，尝试备用方法
    if not results:
        print("Anna's Archive 搜索无结果，尝试备用来源...")
        results = search_alternative(args.query, args.lang)

    if results:
        print(format_results(results))
        print(f"共找到 {len(results)} 本书")
    else:
        print("未找到任何结果")

    # 保存结果供后续使用
    output_file = "/tmp/book_search_results.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n结果已保存到: {output_file}")


if __name__ == "__main__":
    main()
