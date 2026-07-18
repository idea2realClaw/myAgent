#!/usr/bin/env python3
"""
Mac Webcam Photo Taker
打开 Photo Booth，截取摄像头预览区域，在对话中直接显示。

Usage:
    python3 mac_camera.py [--output <path>] [--http-share]
"""

import os
import sys
import subprocess
import time
import json
import argparse

def run_scpt(code: str) -> str:
    result = subprocess.run(
        ["osascript", "-e", code],
        capture_output=True, text=True
    )
    return result.stdout.strip()

def get_window_geometry() -> dict:
    """获取 Photo Booth 窗口位置和大小。"""
    code = '''
tell application "System Events"
    tell process "Photo Booth"
        set frontmost to true
        set winPos to position of window 1
        set winSize to size of window 1
        return (item 1 of winPos as string) & "," & (item 2 of winPos as string) & "," & (item 1 of winSize as string) & "," & (item 2 of winSize as string)
    end tell
end tell
'''
    out = run_scpt(code)
    x, y, w, h = map(int, out.split(","))
    return {"x": x, "y": y, "w": w, "h": h}

def ensure_http_server(share_dir: str, port: int = 3000) -> str:
    """确保 HTTP 文件服务器正在运行，返回 URL。"""
    # 检查是否已运行
    check = subprocess.run(
        ["lsof", "-i", f":{port}"],
        capture_output=True, text=True
    )
    if not check.stdout.strip():
        # 启动服务器（后台运行）
        subprocess.Popen(
            ["python3", "-m", "http.server", str(port)],
            cwd=share_dir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        time.sleep(1.5)
    return f"http://localhost:{port}"

def crop_photo_booth(src_path: str, out_path: str) -> tuple:
    """
    从 Photo Booth 窗口截图中裁剪出摄像头预览区域。
    返回 (output_path, preview_url)
    """
    try:
        from PIL import Image
    except ImportError:
        # 无 PIL 时跳过裁剪，直接返回原图
        return src_path, None

    img = Image.open(src_path)
    w, h = img.size

    # Photo Booth 窗口布局：顶部标题栏约42px，右侧胶片条约180px，底部控制栏约60px
    left = 8
    top = 42
    right = w - 185
    bottom = h - 8

    # 留边安全区
    pad = 6
    left += pad
    top += pad
    right -= pad
    bottom -= pad

    cropped = img.crop((left, top, right, bottom))
    cropped.save(out_path)
    return out_path, None

def take_photo(output_path: str = None, share_via_http: bool = False) -> dict:
    """
    完整拍照流程。
    1. 打开 Photo Booth
    2. 截取窗口
    3. 裁剪预览区
    4. 返回结果信息
    """
    # 1. 关闭已有的 Photo Booth
    subprocess.run(["pkill", "-f", "Photo Booth"], capture_output=True)
    time.sleep(0.5)

    # 2. 打开 Photo Booth
    subprocess.run(["open", "-a", "Photo Booth"])
    time.sleep(2.5)

    # 3. 激活并获取窗口位置
    run_scpt('tell application "Photo Booth" to activate')
    time.sleep(1)
    geo = get_window_geometry()
    print(f"Photo Booth window: x={geo['x']} y={geo['y']} w={geo['w']} h={geo['h']}", file=sys.stderr)

    # 4. 截图
    raw_path = "/tmp/photo_booth_raw.png"
    subprocess.run(
        ["screencapture", "-x", "-R{},{},{},{}".format(
            geo["x"], geo["y"], geo["w"], geo["h"]), raw_path
        ],
        check=True
    )
    print(f"Raw screenshot: {raw_path}", file=sys.stderr)

    # 5. 裁剪
    if output_path is None:
        output_path = "/tmp/mac_camera_photo.png"
    cropped_path, _ = crop_photo_booth(raw_path, output_path)
    print(f"Cropped photo: {cropped_path}", file=sys.stderr)

    # 6. HTTP 分享
    preview_url = None
    if share_via_http:
        share_dir = "/tmp"
        base_url = ensure_http_server(share_dir)
        fname = os.path.basename(output_path)
        # 复制到共享目录
        share_path = os.path.join(share_dir, fname)
        if output_path != share_path:
            import shutil
            shutil.copy(output_path, share_path)
        preview_url = f"{base_url}/{fname}"
        print(f"HTTP preview: {preview_url}", file=sys.stderr)

    return {
        "path": cropped_path,
        "preview_url": preview_url,
        "window_geometry": geo
    }

def main():
    parser = argparse.ArgumentParser(description="Mac Webcam Photo Taker")
    parser.add_argument("--output", "-o", default=None, help="Output image path")
    parser.add_argument("--http-share", action="store_true", help="Start HTTP server and return URL")
    args = parser.parse_args()

    result = take_photo(
        output_path=args.output,
        share_via_http=args.http_share
    )

    # 输出 JSON（供 AI 读取）
    print(json.dumps(result, indent=2))
    return result

if __name__ == "__main__":
    main()
