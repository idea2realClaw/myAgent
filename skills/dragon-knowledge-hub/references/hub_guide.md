# 龙族共享知识库使用说明

## 📁 目录结构

```
dragon-share/           # 共享根目录（服务器端）
├── memory/             # 各徒弟的 MEMORY.md
│   ├── zxd_MEMORY.md          # 师父
│   ├── longsung_MEMORY.md     # 龙松
│   ├── longzhu_MEMORY.md      # 龙竹
│   ├── longmei_MEMORY.md      # 龙梅
│   ├── longmuxin_MEMORY.md    # 龙木心
│   └── ...
├── skills/             # 共享的 Skill（zip 格式）
│   ├── ftp-setup.zip           # FTP 服务搭建技能
│   ├── dragon-knowledge-hub.zip # 本 Skill
│   └── ...
├── resources/          # 其他资源文件
└── logs/               # 操作日志
    └── access.log
```

## 👥 用户账号

| 用户名 | 身份 | 默认密码 |
|--------|------|----------|
| zxd | 师父 | 123456 |
| longsung | 龙松 | pass123 |
| longzhu | 龙竹 | pass456 |
| longmei | 龙梅 | pass789 |
| longmuxin | 龙木心 | wood123 |
| longhuoer | 龙火儿 | fire456 |
| longtudou | 龙土豆 | earth789 |
| longjinbao | 龙金宝 | gold111 |
| longshui | 龙水珠 | water222 |

> 🔐 **安全提示**：部署后请通知各徒弟自行修改密码，将密码告知师父备案。

## 🌐 服务器地址

每次启动时 Cloudflare Tunnel 会生成新的临时地址，需要通知徒弟们更新配置：

```bash
python3 dragon_sync.py config set server https://xxxx.trycloudflare.com
```

若要固定地址，可升级到 Cloudflare 付费版使用自定义域名隧道。

## 🔌 API 接口说明

服务器基于 HTTP，支持：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 列出根目录 |
| GET | `/<路径>/` | 列出子目录 |
| GET | `/<路径/文件名>` | 下载文件 |
| POST | `/<路径/文件名>` | 上传文件 |
| DELETE | `/<路径/文件名>` | 删除文件 |
