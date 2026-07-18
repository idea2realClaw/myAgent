---
name: song-finder
description: 找歌、识歌、下载音乐。根据用户提供的零散线索（歌词片段、旋律描述、歌手特征、年代、语言、翻唱关系等）定位歌曲，确认后自动下载MP3。触发词：找首歌、帮我找歌、这首歌是谁唱的、下载歌曲、找音乐、什么歌、哪首歌、翻唱版本、原唱是谁、帮我下首歌
---

# Song Finder — 找歌 & 下载

## 概述
根据用户的模糊线索找到歌曲，确认后下载高品质 MP3（优先 320kbps）。

## 依赖
- Python 3.7+
- 已安装: `pip install musicdl ffmpeg-python`
- 系统工具: `ffmpeg`（用于格式转换）

## 工作流程

### Phase 1: 线索分析与多源搜索

1. **解析用户线索**：提取关键词，识别以下维度：
   - 歌名/歌词片段
   - 歌手/乐队名称（含别名、外文名）
   - 年代/时期
   - 语言（中文/英文/其他）
   - 音乐风格（和声、假声、摇滚、迪斯科等）
   - 翻唱/原唱关系
   - 专辑/磁带/黑胶等载体信息

2. **多源搜索**（按优先级依次尝试）：
   - `web_search` 搜索：歌词+歌手+年代等组合关键词
   - 豆瓣音乐、Discogs、SecondHandSongs 等数据库
   - YouTube、B站等平台

3. **交叉验证**：将搜索结果与用户线索逐一比对，确认匹配度

### Phase 2: 确认与深化

4. **向用户呈现候选结果**：列出最匹配的 2-3 个选项，附带：
   - 歌手/乐队背景
   - 所属专辑
   - 翻唱关系（如适用）
   - 与用户线索的匹配说明

5. **用户确认**后进入下载阶段；若都不匹配，根据用户新线索继续搜索

### Phase 3: 下载

6. **调用 `scripts/download.py`** 完成搜索和下载：
   ```
   python3 scripts/download.py --keyword "歌手 歌名" --output /path/to/save [--source SOURCE] [--quality 320] [--format mp3]
   ```
   - `--source`: 可选 kugou/netease/qq/kuwo/migu，默认自动选择
   - `--quality`: 128/320/1000(lossless)，默认 320
   - `--format`: mp3/flac，默认 mp3
   - 脚本输出 MP3 文件路径和元数据

7. **验证文件**：检查文件大小、格式、ID3标签
8. **发送给用户**：通过 `deliver_attachments` 发送 MP3 文件

## 关键经验

### 搜索策略
- 用户记忆可能有偏差（记混歌名、年代、语言等），**先广后窄**
- 中文歌名搜索不到时，尝试英文原名；反之亦然
- "雪莉" 可能是 Sherry、Cheri Cheri Lady 等不同歌曲的中文翻译
- 台湾乐队在大陆引进时经常改名（如"印象合唱团"→"猛虎队"）
- SecondHandSongs 是查翻唱关系的最佳数据库（但可能有反爬）

### 下载技术栈
- **musicdl** (v2.11+): 核心下载库，支持 40+ 平台，2026 年仍在维护
  - **v2.11+ API 变更**: 不再有 `MusicClient` 统一入口，需直接导入各源 Client
  - 导入方式: `from musicdl.modules.sources.kugou import KugouMusicClient`
  - 搜索: `client = KugouMusicClient(); results = client.search(keyword='...')`
  - 下载: `downloaded = client.download(song_infos=[results[0]])`
  - 返回 list[SongInfo]，不再是 dict
  - SongInfo 属性: song_name, singers, album, ext, file_size, download_url, lyric, duration
  - 下载后通过 `downloaded[0].work_dir` 找到下载目录
- 酷狗移动端 API 可直接搜索（不需要认证）：
  - `http://mobilecdnbj.kugou.com/api/v3/search/song?keyword=...&page=1&pagesize=20&platid=4`
- 网易云 API（仅非 VIP 免费）：
  - `http://music.163.com/song/media/outer/url?id={ID}.mp3`
- `ffmpeg` 用于 FLAC→MP3 转换：`ffmpeg -i input.flac -codec:a libmp3lame -b:a 320k output.mp3`

### 翻唱歌曲处理
1. 先查原唱信息
2. 再搜索翻唱版本（加 "翻唱/cover/版本" 关键词）
3. 豆瓣评论和论坛常有翻唱关系讨论
4. 音乐论坛（捌零音乐论坛、音乐联合国）有高质量资源帖

## 输出格式
下载完成后提供：
```
🎵 歌名: 雪莉
🎤 歌手: 印象合唱团
💿 专辑: 群星会40
⏱ 时长: 03:16
📦 格式: MP3 320kbps / 6.8MB
📝 作词: 谭小葳
```
