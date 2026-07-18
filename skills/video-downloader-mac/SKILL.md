# Video Downloader Skill

## 功能说明
使用 yt-dlp 下载各平台视频，支持 YouTube、B站、Twitter、TikTok 等主流平台。

## 使用场景
- 用户想下载某个视频
- 用户提供视频链接要求保存到本地
- 用户要求提取音频（MP3）
- 用户要求下载播放列表

## 执行方式

当用户提供视频链接，执行以下步骤：

1. 调用 `scripts/downloader.py` 脚本
2. 默认下载到 `~/Downloads/videos/` 目录
3. 自动选择最佳画质

## 脚本调用方式

```bash
# 下载视频（最佳画质）
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py --url "URL" 

# 指定输出目录
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py --url "URL" --output "/path/to/dir"

# 只下载音频
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py --url "URL" --audio-only

# 指定分辨率
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py --url "URL" --quality 720

# 查看可用格式
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py --url "URL" --list-formats
```

## 支持平台
YouTube、B站、Twitter/X、TikTok、Instagram、Facebook、Vimeo 等 1000+ 网站

## 依赖
- Python 3.x
- yt-dlp（`pip3 install yt-dlp`）
- ffmpeg（可选，用于合并视频/音频流）
