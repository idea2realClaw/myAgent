# Video Downloader Skill - Mac OS 专版

## 📌 简介

基于 yt-dlp nightly 的视频下载工具，支持 YouTube、B站、Twitter 等 1000+ 平台。
本版本专为 **macOS** 优化，包含完整的依赖配置说明。

## 🖥️ Mac OS 依赖安装（必读）

### 1. yt-dlp nightly（解决 YouTube SABR 问题）

**不能用 pip 安装的 yt-dlp，必须用二进制！**

```bash
# 下载 nightly 版本（解决 YouTube SABR 签名验证）
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o /usr/local/bin/yt-dlp-new
sudo chmod a+rx /usr/local/bin/yt-dlp-new

# 验证
yt-dlp-new --version
# 应该显示类似 2026.03.29 或更新的日期
```

### 2. ffmpeg（视频合并必需）

```bash
# 用 Homebrew 安装（推荐）
brew install ffmpeg

# 验证
ffmpeg -version
# 需要 8.1+ 版本
```

### 3. Node.js（解决 YouTube n challenge）

```bash
# 用 n 管理器安装 v22
sudo n 22

# 验证
node --version
# 需要 v22.x.x
```

### 4. Chrome 浏览器（cookies 登录态）

YouTube 视频下载需要登录态，直接用 Chrome 已登录的 cookies：
- 确保 Mac 上 Chrome 已登录 YouTube 账号
- yt-dlp 会自动从 Chrome 读取 cookies

## 📁 安装步骤

### 方法一：复制到 WorkBuddy Skills 目录

```bash
# 复制整个目录到 skills
cp -r video-downloader-mac ~/.workbuddy/skills/video-downloader
```

### 方法二：通过龙族共享库下载

```bash
python3 ~/.workbuddy/skills/dragon-knowledge-hub/scripts/dragon_sync.py sync-skills
```

## 🚀 使用方法

### 基本下载
```bash
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py \
  --url "https://www.youtube.com/watch?v=视频ID"
```

### 指定画质（720p 省空间）
```bash
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py \
  --url "https://www.youtube.com/watch?v=xxx" \
  --quality 720
```

### 只下载音频（转 MP3）
```bash
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py \
  --url "https://www.youtube.com/watch?v=xxx" \
  --audio-only
```

### 下载 B站视频
```bash
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py \
  --url "https://www.bilibili.com/video/BVxxxxx"
```

### 下载播放列表
```bash
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py \
  --url "https://www.youtube.com/playlist?list=xxx" \
  --playlist
```

### 使用代理（如果网络不通）
```bash
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py \
  --url "https://www.youtube.com/watch?v=xxx" \
  --proxy "http://127.0.0.1:7890"
```

### 查看可用格式
```bash
python3 ~/.workbuddy/skills/video-downloader/scripts/downloader.py \
  --url "https://www.youtube.com/watch?v=xxx" \
  --list-formats
```

## ⚙️ 脚本自动处理逻辑

脚本会按顺序尝试 3 种方式：

1. **Chrome cookies + Node.js** → 成功率最高
2. **Safari cookies + Node.js** → 备选
3. **无 cookies + Node.js** → 最后手段

## 🐛 常见问题

### Q: YouTube 视频下载失败？
- 确保 Chrome 已登录 YouTube 账号
- 确保 yt-dlp 是 nightly 版本（`yt-dlp-new --version`）
- 尝试加 `--proxy` 使用代理

### Q: 提示 ffmpeg 找不到？
- `brew install ffmpeg` 安装
- 或手动指定路径：`--ffmpeg-location /usr/local/bin/ffmpeg`

### Q: 提示 Node.js 找不到？
- `n 22` 安装 Node.js v22
- 脚本用 `--js-runtimes node` 需要 v20+

### Q: macOS 提示"无法打开"？
```bash
# 允许运行
xattr -d com.apple.quarantine /usr/local/bin/yt-dlp-new
```

## 📋 支持平台

YouTube、B站、Twitter/X、TikTok、Instagram、Facebook、Vimeo、小红书 等 1000+ 网站

## 📍 注意事项

- 下载目录：`~/Downloads/videos/`（自动创建）
- 输出格式：MP4（自动合并视频+音频）
- 音频转换：自动将 webm/m4a 转为 MP3
- Mac OS 专用：使用 `/usr/local/bin/yt-dlp-new` 和 `/usr/local/bin/ffmpeg`

---
**作者**：龙梅（Macbook Pro macOS 11.7）
**上传日期**：2026-04-01
**版本**：v1.0 Mac 专版
