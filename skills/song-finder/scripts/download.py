#!/usr/bin/env python3
"""
Song Finder - 音乐搜索与下载脚本
基于 musicdl 库，支持酷狗、网易云、QQ音乐等40+平台

用法:
    python3 download.py --keyword "歌手 歌名" --output /path/to/save
    python3 download.py --keyword "印象合唱团 雪莉" --output ./music --quality 320
    python3 download.py --keyword "周杰伦 晴天" --source kugou --format flac

参数:
    --keyword   搜索关键词（歌名+歌手最佳）
    --output    输出目录（默认 ./music_output）
    --source    音乐源: kugou/netease/qq/kuwo/migu（默认自动选择最佳源）
    --quality   音质: 128/320/1000（无损，默认320）
    --format    输出格式: mp3/flac（默认mp3）
    --top       下载搜索结果中的第几首（默认1，即第一首）
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import shutil


def ensure_musicdl():
    """确保 musicdl 已安装"""
    try:
        import musicdl
        return musicdl
    except ImportError:
        print("正在安装 musicdl...")
        subprocess.run([sys.executable, "-m", "pip", "install", "musicdl", "-q"],
                       check=True)
        import musicdl
        return musicdl


def get_musicdl_client(source=None):
    """
    获取 musicdl 客户端（兼容 v2.11+ 新 API）
    musicdl v2.11+ 不再有 MusicClient 统一入口，需直接导入各源 Client
    """
    from musicdl.modules.sources.kugou import KugouMusicClient
    from musicdl.modules.sources.netease import NeteaseMusicClient
    from musicdl.modules.sources.qq import QQMusicClient
    from musicdl.modules.sources.kuwo import KuwoMusicClient
    from musicdl.modules.sources.migu import MiguMusicClient

    source_map = {
        'kugou': KugouMusicClient,
        'netease': NeteaseMusicClient,
        'qq': QQMusicClient,
        'kuwo': KuwoMusicClient,
        'migu': MiguMusicClient,
    }

    if source and source in source_map:
        return [source_map[source]()]
    else:
        # 默认使用酷狗+网易云+QQ音乐
        return [KugouMusicClient(), NeteaseMusicClient(), QQMusicClient()]


def ensure_ffmpeg():
    """检查 ffmpeg 是否可用"""
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        return result.returncode == 0
    except FileNotFoundError:
        return False


def search_and_download(keyword, source=None, output_dir="./music_output", quality=320, fmt="mp3", top=1):
    """
    搜索并下载歌曲（兼容 musicdl v2.11+）
    
    Args:
        keyword: 搜索关键词
        source: 音乐源名称（None=自动选择）
        output_dir: 输出目录
        quality: 音质等级
        fmt: 输出格式 (mp3/flac)
        top: 下载第几首结果
    
    Returns:
        dict: {"success": bool, "filepath": str, "info": dict, "error": str}
    """
    ensure_musicdl()
    
    # Create output directory
    os.makedirs(output_dir, exist_ok=True)
    
    # Get clients (v2.11+ API: individual clients, not MusicClient)
    clients = get_musicdl_client(source)
    
    # Search across all clients
    print(f"🔍 搜索: {keyword}", file=sys.stderr)
    all_songs = []
    for client in clients:
        try:
            results = client.search(keyword=keyword)
            src_name = client.__class__.__name__.replace('MusicClient', '')
            if results:
                for i, s in enumerate(results[:3]):
                    print(f"  [{src_name}] {s.song_name} - {s.singers} ({s.file_size}, {s.ext})",
                          file=sys.stderr)
                all_songs.extend(results)
        except Exception as e:
            print(f"  [{client.__class__.__name__}] 搜索失败: {e}", file=sys.stderr)
    
    if not all_songs:
        return {
            "success": False,
            "filepath": None,
            "info": None,
            "error": f"未找到与 '{keyword}' 相关的歌曲"
        }
    
    # Select the target song
    idx = min(top - 1, len(all_songs) - 1)
    target_song = all_songs[idx]
    # Find which client this song came from
    target_client = None
    for client in clients:
        try:
            results = client.search(keyword=keyword)
            if results and idx < len(results):
                target_client = client
                break
        except Exception:
            continue
    
    if not target_client:
        target_client = clients[0]
    
    print(f"\n📥 下载: {target_song.song_name} - {target_song.singers} ({target_song.file_size}, {target_song.ext})",
          file=sys.stderr)
    
    # Download
    try:
        downloaded = target_client.download(song_infos=[target_song])
    except Exception as e:
        return {
            "success": False,
            "filepath": None,
            "info": None,
            "error": f"下载失败: {e}"
        }
    
    if not downloaded:
        return {
            "success": False,
            "filepath": None,
            "info": None,
            "error": "下载失败"
        }
    
    song = downloaded[0]
    work_dir = song.work_dir
    
    # Find the downloaded audio file
    audio_file = None
    for root, dirs, files in os.walk(work_dir):
        for f in files:
            if f.endswith(('.flac', '.mp3', '.m4a', '.wav', '.ogg')):
                audio_file = os.path.join(root, f)
                break
        if audio_file:
            break
    
    if not audio_file:
        return {
            "success": False,
            "filepath": None,
            "info": None,
            "error": "下载完成但未找到音频文件"
        }
    
    # Build output filename
    safe_name = f"{target_song.singers} - {target_song.song_name}"
    for ch in ['/', '\\', ':', '*', '?', '"', '<', '>', '|']:
        safe_name = safe_name.replace(ch, '_')
    
    if fmt == 'mp3' and audio_file.endswith('.flac'):
        if not ensure_ffmpeg():
            print("⚠️  ffmpeg 未安装，保持 FLAC 格式", file=sys.stderr)
            output_file = os.path.join(output_dir, f"{safe_name}.flac")
            shutil.copy2(audio_file, output_file)
        else:
            output_file = os.path.join(output_dir, f"{safe_name}.mp3")
            quality_map = {128: '128k', 320: '320k', 1000: '320k'}
            bitrate = quality_map.get(quality, '320k')
            cmd = ['ffmpeg', '-i', audio_file, '-codec:a', 'libmp3lame', '-b:a', bitrate, '-y', output_file]
            subprocess.run(cmd, capture_output=True, text=True)
            if not os.path.exists(output_file):
                output_file = audio_file
    else:
        ext = os.path.splitext(audio_file)[1]
        output_file = os.path.join(output_dir, f"{safe_name}{ext}")
        shutil.copy2(audio_file, output_file)
    
    # Get file info
    file_size = os.path.getsize(output_file)
    file_ext = os.path.splitext(output_file)[1].lstrip('.')
    
    info = {
        "song_name": target_song.song_name,
        "singers": target_song.singers,
        "album": target_song.album,
        "duration": target_song.duration,
        "format": f"{file_ext.upper()}",
        "file_size": f"{file_size / 1024 / 1024:.1f} MB",
        "file_size_bytes": file_size,
        "source": target_client.__class__.__name__,
        "lyric": target_song.lyric[:200] if target_song.lyric else None,
    }
    
    print(f"✅ 下载成功: {output_file} ({info['file_size']})", file=sys.stderr)
    
    return {
        "success": True,
        "filepath": os.path.abspath(output_file),
        "info": info,
        "error": None
    }


def main():
    parser = argparse.ArgumentParser(description='Song Finder - 音乐搜索与下载')
    parser.add_argument('--keyword', '-k', required=True, help='搜索关键词')
    parser.add_argument('--output', '-o', default='./music_output', help='输出目录')
    parser.add_argument('--source', '-s', default=None, help='音乐源: kugou/netease/qq/kuwo/migu')
    parser.add_argument('--quality', '-q', type=int, default=320, help='音质: 128/320/1000')
    parser.add_argument('--format', '-f', default='mp3', help='格式: mp3/flac')
    parser.add_argument('--top', '-t', type=int, default=1, help='下载第几首结果')
    
    args = parser.parse_args()
    
    result = search_and_download(
        keyword=args.keyword,
        source=args.source,
        output_dir=args.output,
        quality=args.quality,
        fmt=args.format,
        top=args.top
    )
    
    # Output as JSON for programmatic use
    print(json.dumps(result, ensure_ascii=False, indent=2))
    
    if not result["success"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
