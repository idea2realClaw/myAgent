#!/usr/bin/env python3
"""
Z-Library SPA 搜索和下载模块 v2
关键发现（2026-04-04）：书籍用 <Z-BOOKCARD> Web Component 渲染，
href 属性包含完整路径 /book/xxxxx/title.html
必须用 Playwright 才能提取 shadow DOM 中的数据
"""
import json, os, re, ssl, sys, time, urllib.request, urllib.parse
import http.cookiejar
from typing import Dict, List, Optional

try:
    from playwright.sync_api import sync_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False
    print("⚠️  Playwright 未安装，Z-Library 搜索不可用")
    print("   修复: /Library/Frameworks/Python.framework/Versions/3.10/bin/python3 -m pip install playwright")
    print("        然后: playwright install chromium")

# ── 已验证可用的镜像 ─────────────────────────────────────
ZLIB_MIRRORS = [
    "https://zh.z-lib.fm",
    "https://zh.z-lib.gs",
    "https://z-lib.fm",
    "https://z-lib.gs",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate",
}

# ── HTTP 工具函数 ─────────────────────────────────────────

def _http_get(url: str, timeout: int = 20) -> str:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPCookieProcessor(cj),
    )
    opener.addheaders = list(HEADERS.items())
    resp = opener.open(url, timeout=timeout)
    raw = resp.read()
    try:
        import gzip
        if "gzip" in resp.headers.get("Content-Encoding", ""):
            raw = gzip.decompress(raw)
    except:
        pass
    return raw.decode("utf-8", errors="replace")


# ── Playwright 搜索 ──────────────────────────────────────

def _playwright_search(query: str, mirror: str) -> List[Dict]:
    """用 Playwright 搜索 Z-Library"""
    with sync_playwright() as p:
        browser = p.firefox.launch(headless=True)
        page = browser.new_page(
            user_agent=HEADERS["User-Agent"],
            locale="zh-CN",
        )

        search_url = f"{mirror}/s/{urllib.parse.quote(query)}"
        print(f"    打开: {search_url}")
        page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(6000)

        # 提取 Z-BOOKCARD Web Component 数据
        # 注意：使用函数参数传递 mirror，避免变量作用域问题
        books_data = page.evaluate(
            """
            (mr) => {
                const results = [];
                const seen = new Set();

                document.querySelectorAll('z-bookcard, z-book-card, z-bookcard-element').forEach(el => {
                    let href = el.getAttribute('href') ||
                               el.getAttribute('data-href') ||
                               (el.dataset && el.dataset.href) || '';

                    if (!href && el.shadowRoot) {
                        const link = el.shadowRoot.querySelector('a[href*="/book/"]');
                        if (link) href = link.getAttribute('href');
                    }

                    let title = (el.getAttribute('title') || '').trim() ||
                                (el.getAttribute('data-title') || '').trim() ||
                                (el.innerText || '').trim();
                    title = title.split('\\n')[0].trim().substring(0, 120);

                    let author = (el.getAttribute('author') ||
                                  el.getAttribute('data-author') || '').trim();

                    let year = '';
                    const m = (el.innerText || '').match(/\\b(19|20)\\d{2}\\b/);
                    if (m) year = m[0];

                    if (href && href.includes('/book/') && !seen.has(href)) {
                        seen.add(href);
                        results.push({
                            title: title, author: author, year: year,
                            path: href,
                            href: href.startsWith('http') ? href : mr + href,
                        });
                    }
                });

                if (results.length === 0) {
                    document.querySelectorAll('a[href*="/book/"]').forEach(a => {
                        const href = a.getAttribute('href');
                        if (seen.has(href)) return;
                        seen.add(href);
                        const t = (a.textContent || '').trim().substring(0, 120);
                        if (t && t.length > 2) {
                            results.push({
                                title: t, author: '', year: '',
                                path: href,
                                href: href.startsWith('http') ? href : mr + href,
                            });
                        }
                    });
                }

                return results;
            }
            """,
            mirror,
        )

        browser.close()
        p.stop()
        return books_data


def _playwright_get_download_link(book_page_url: str) -> Optional[str]:
    """用 Playwright 提取下载链接"""
    with sync_playwright() as p:
        browser = p.firefox.launch(headless=True)
        page = browser.new_page(user_agent=HEADERS["User-Agent"])

        page.goto(book_page_url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(4000)

        dl_url = page.evaluate("""
            () => {
                // 1. 找 <a href*="/dl/">
                const dlLinks = document.querySelectorAll('a[href*="/dl/"]');
                for (const a of dlLinks) {
                    const h = a.getAttribute('href');
                    if (h && h.includes('/dl/')) return h;
                }

                // 2. shadow DOM 中的下载链接
                document.querySelectorAll('z-bookcard, z-book-card').forEach(el => {
                    if (el.shadowRoot) {
                        const dl = el.shadowRoot.querySelector('a[href*="/dl/"]');
                        if (dl) return dl.getAttribute('href');
                    }
                });

                // 3. 整页 HTML 搜索
                const html = document.documentElement.innerHTML;
                const match = html.match(/href=["']([^"']*\\/dl\\/[^"']+)["']/);
                if (match) return match[1];

                return null;
            }
        """)

        browser.close()
        p.stop()
        return dl_url


# ── HTTP 备用下载链接提取 ────────────────────────────────

def _http_get_download_link(book_page_url: str) -> Optional[str]:
    """纯 HTTP 提取下载链接"""
    try:
        html = _http_get(book_page_url, timeout=30)
        # 找 /dl/ 链接
        match = re.search(r'href="([^"]*\/dl\/[^"]+)"', html)
        if match:
            dl_path = match.group(1)
            base = book_page_url.split('/book/')[0]
            return dl_path if dl_path.startswith('http') else base + dl_path
        # 备选
        match2 = re.search(r'["\'](/dl/[^"\']+)["\']', html)
        if match2:
            dl_path = match2.group(1)
            base = book_page_url.split('/book/')[0]
            return dl_path if dl_path.startswith('http') else base + dl_path
        return None
    except Exception as e:
        print(f"  HTTP 下载链接失败: {e}")
        return None


# ── 公开 API ──────────────────────────────────────────────

def search_zlib(query: str, lang: Optional[str] = None) -> List[Dict]:
    """
    搜索 Z-Library，返回书籍列表
    [{title, author, year, path, href}]
    """
    print(f"\n🔍 Z-Library 搜索: {query}")

    for mirror in ZLIB_MIRRORS:
        try:
            print(f"  尝试: {mirror}")
            books = _playwright_search(query, mirror)
            if books:
                print(f"  ✅ 找到 {len(books)} 本书")
                seen = set()
                unique = []
                for b in books:
                    if b["path"] not in seen:
                        seen.add(b["path"])
                        unique.append(b)
                return unique
        except Exception as e:
            print(f"  ❌ {mirror}: {e}")
            continue

    print("  ⚠️  所有镜像均不可用")
    return []


def get_download_link(book_page_url: str) -> Optional[str]:
    """获取书籍下载链接"""
    dl_url = _http_get_download_link(book_page_url)
    if dl_url:
        print(f"  HTTP 获取成功: {dl_url[:60]}...")
        return dl_url

    print("  HTTP 失败，尝试 Playwright...")
    return _playwright_get_download_link(book_page_url)


def download_file(url: str, output_path: str) -> bool:
    """下载文件"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPCookieProcessor(cj),
    )
    opener.addheaders = list(HEADERS.items())

    try:
        print(f"  下载: {url[:60]}...")
        req = urllib.request.Request(url, headers=HEADERS)
        resp = opener.open(req, timeout=300)

        total_size = int(resp.headers.get("Content-Length", 0))
        downloaded = 0

        with open(output_path, "wb") as f:
            first = resp.read(512)
            is_pdf = first.startswith(b"%PDF")
            is_epub = first[:4] == b"PK\x03\x04"

            if not is_pdf and not is_epub:
                rest = resp.read(2048)
                if "<html" in (first + rest).decode("utf-8", errors="replace").lower():
                    print("  ⚠️  收到 HTML 错误页")
                    return False
                f.write(first + rest)
                downloaded = len(first) + len(rest)
            else:
                f.write(first)
                downloaded = len(first)

            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total_size > 0:
                    pct = downloaded / total_size * 100
                    print(f"\r  进度: {pct:.1f}%", end="", flush=True)

        print(f"\n  ✅ 完成: {downloaded/1024/1024:.1f} MB")
        return downloaded > 10240

    except Exception as e:
        print(f"\n  下载失败: {e}")
        if os.path.exists(output_path):
            os.remove(output_path)
        return False


def download_zlib_book(book: Dict, output_dir: str = "~/Downloads/books") -> str:
    """下载 Z-Library 书籍"""
    output_dir = os.path.expanduser(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    book_url = book.get("href", "")
    if not book_url:
        print("  缺少书籍 URL")
        return ""

    title = book.get("title", "book")
    safe = re.sub(r'[^\w\u4e00-\u9fff\s\-_]', '', title).strip()[:60]
    output_path = os.path.join(output_dir, f"{safe}.pdf")

    print(f"\n⬇️  下载: {title}")
    print(f"  页面: {book_url}")

    dl_url = get_download_link(book_url)
    if not dl_url:
        print("  ⚠️  无法获取下载链接")
        return ""

    if download_file(dl_url, output_path):
        return output_path
    return ""


# ── CLI ──────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Z-Library SPA 搜索和下载")
    parser.add_argument("query", help="搜索关键词")
    parser.add_argument("--index", "-i", type=int, default=0)
    parser.add_argument("--output", "-o", default="~/Downloads/books")
    parser.add_argument("--search-only", "-s", action="store_true")

    args = parser.parse_args()
    books = search_zlib(args.query)

    if not books:
        print("\n未找到书籍")
        sys.exit(1)

    print(f"\n共 {len(books)} 本:")
    for i, b in enumerate(books[:20]):
        print(f"  [{i}] {b.get('title','')[:60]}")
        if b.get('author'):
            print(f"       作者: {b['author']}")

    if args.search_only:
        sys.exit(0)

    book = books[min(args.index, len(books) - 1)]
    path = download_zlib_book(book, args.output)
    if path:
        print(f"\n📁 已保存: {path}")
    else:
        print("\n⚠️  下载失败")
        sys.exit(1)
