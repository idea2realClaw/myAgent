#!/usr/bin/env python3
"""
Video Downloader - 基于 yt-dlp 的视频下载工具
支持 YouTube、B站、Twitter、TikTok 等 1000+ 平台

依赖：
  - /usr/local/bin/yt-dlp-new  (yt-dlp nightly 二进制，解决SABR问题)
  - /usr/local/bin/ffmpeg       (用于合并视频+音频)
  - Node.js >= 20              (用于 n challenge 解密)
"""

import argparse
import os
import sys
import subprocess
import shutil

# yt-dlp 二进制路径（优先用新版nightly）
YTDLP_BIN = "/usr/local/bin/yt-dlp-new"
if not os.path.exists(YTDLP_BIN):
    YTDLP_BIN = shutil.which("yt-dlp") or "yt-dlp"

FFMPEG_BIN = "/usr/local/bin/ffmpeg"
if not os.path.exists(FFMPEG_BIN):
    FFMPEG_BIN = shutil.which("ffmpeg") or "ffmpeg"


def get_default_output_dir():
    """获取默认下载目录"""
    download_dir = os.path.expanduser("~/Downloads/videos")
    os.makedirs(download_dir, exist_ok=True)
    return download_dir


def run_ytdlp(args_list, capture=False):
    """运行 yt-dlp 命令"""
    cmd = [YTDLP_BIN] + args_list
    if capture:
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result
    else:
        result = subprocess.run(cmd)
        return result


def list_formats(url):
    """列出视频可用格式"""
    print(f"\n📋 正在获取视频格式列表: {url}\n")
    run_ytdlp([
        "--cookies-from-browser", "chrome",
        "--js-runtimes", "node",
        "-F", url
    ])


def download_video(url, output_dir=None, quality=None, audio_only=False, playlist=False, proxy=None):
    """
    智能下载视频，使用 yt-dlp nightly + Node.js runtime + ffmpeg
    """
    if output_dir is None:
        output_dir = get_default_output_dir()

    print(f"\n🎬 开始下载视频")
    print(f"📁 保存目录: {output_dir}")
    print(f"🔗 视频链接: {url}")
    if audio_only:
        print(f"🎵 模式：仅音频 (MP3)")
    elif quality:
        print(f"📺 模式：{quality}p 画质")
    else:
        print(f"📺 模式：最佳画质")

    output_template = os.path.join(output_dir, "%(title)s.%(ext)s")

    # 构建格式选项
    if audio_only:
        format_str = "bestaudio/best"
    elif quality:
        format_str = f"bestvideo[height<={quality}]+bestaudio/best[height<={quality}]"
    else:
        format_str = "bestvideo+bestaudio/best"

    # 基础参数
    base_args = [
        "--js-runtimes", "node",   # 使用 Node.js 解决 n challenge（SABR 关键）
        "--merge-output-format", "mp4",
        "-f", format_str,
        "-o", output_template,
        "--ffmpeg-location", FFMPEG_BIN,
        "--no-playlist" if not playlist else "--yes-playlist",
    ]

    if proxy:
        base_args += ["--proxy", proxy]

    # 尝试策略列表
    attempts = [
        {
            "desc": "方式 1/3：Chrome cookies + Node.js JS runtime",
            "extra": ["--cookies-from-browser", "chrome"],
        },
        {
            "desc": "方式 2/3：Safari cookies + Node.js JS runtime",
            "extra": ["--cookies-from-browser", "safari"],
        },
        {
            "desc": "方式 3/3：无 cookies + Node.js JS runtime",
            "extra": [],
        },
    ]

    for attempt in attempts:
        print(f"\n🔄 {attempt['desc']}")
        args = base_args + attempt["extra"] + [url]
        result = run_ytdlp(args)
        if result.returncode == 0:
            print(f"\n✅ 下载完成！")
            print(f"📁 保存到：{output_dir}")
            if audio_only:
                # 转 mp3
                _convert_to_mp3(output_dir)
            return True
        else:
            print(f"   ⚠️  失败，尝试下一种方式...")

    print(f"\n❌ 所有方式均失败。")
    print("\n💡 解决建议：")
    print("   1. 确保 Chrome 已登录 YouTube 账号")
    print("   2. 使用代理：--proxy http://127.0.0.1:7890")
    print("   3. 手动导出 cookies：--cookies-file cookies.txt")
    sys.exit(1)


def _convert_to_mp3(output_dir):
    """将 webm/m4a 转换为 mp3"""
    for f in os.listdir(output_dir):
        if f.endswith((".webm", ".m4a")) and not f.endswith(".part"):
            src = os.path.join(output_dir, f)
            dst = os.path.join(output_dir, os.path.splitext(f)[0] + ".mp3")
            subprocess.run([FFMPEG_BIN, "-i", src, "-q:a", "0", dst, "-y"],
                           capture_output=True)
            os.remove(src)


def main():
    parser = argparse.ArgumentParser(
        description="🎬 视频下载工具 - 支持 YouTube、B站等 1000+ 平台",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  下载最佳画质:
    python3 downloader.py --url "https://www.youtube.com/watch?v=xxx"

  下载 720p:
    python3 downloader.py --url "https://www.youtube.com/watch?v=xxx" --quality 720

  仅下载音频 (MP3):
    python3 downloader.py --url "https://www.youtube.com/watch?v=xxx" --audio-only

  下载到指定目录:
    python3 downloader.py --url "https://..." --output "/Users/zxd/Desktop"

  使用代理:
    python3 downloader.py --url "https://..." --proxy "http://127.0.0.1:7890"

  下载整个播放列表:
    python3 downloader.py --url "https://..." --playlist

  查看可用格式:
    python3 downloader.py --url "https://..." --list-formats
        """
    )

    parser.add_argument("--url", "-u", required=True, help="视频链接")
    parser.add_argument("--output", "-o", default=None, help="保存目录（默认: ~/Downloads/videos）")
    parser.add_argument("--quality", "-q", type=int, default=None, help="视频分辨率，如 720、1080")
    parser.add_argument("--audio-only", "-a", action="store_true", help="仅下载音频 (MP3)")
    parser.add_argument("--playlist", "-p", action="store_true", help="下载整个播放列表")
    parser.add_argument("--list-formats", "-F", action="store_true", help="列出可用格式")
    parser.add_argument("--proxy", default=None, help="代理地址，如 http://127.0.0.1:7890")

    args = parser.parse_args()

    if args.list_formats:
        list_formats(args.url)
    else:
        download_video(
            url=args.url,
            output_dir=args.output,
            quality=args.quality,
            audio_only=args.audio_only,
            playlist=args.playlist,
            proxy=args.proxy,
        )


if __name__ == "__main__":
    main()
