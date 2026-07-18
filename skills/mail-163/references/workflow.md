# 163 邮箱 Skill 工作流参考

## 官方配置要点

依据网易 163 邮箱帮助中心，手动配置邮件客户端时建议使用以下参数：

| 协议 | 服务器 | 端口 | 加密 |
|---|---|---:|---|
| IMAP | `imap.163.com` | `993` | SSL |
| SMTP | `smtp.163.com` | `465` 或 `994` | SSL |
| POP3 | `pop.163.com` | `995` | SSL |

### 认证要求

- 第三方客户端登录不要使用网页登录密码
- 应使用 163 邮箱生成的“客户端授权码”
- 开启 IMAP / SMTP / POP3 时，可能需要按网易页面提示完成短信验证

## 推荐执行策略

### 场景 1：用户直接给明文授权码

优先走临时凭证模式：

```bash
python mail163_tool.py --email yourname@163.com --auth-code xxxxx inbox
```

只有在用户明确要求长期保存时，才写入 `~/.workbuddy/mail163.conf`。

### 场景 2：用户给加密后的授权码

推荐流程：

1. 使用 `shared-secret-crypto` 按共享密钥在本地解密
2. 不在普通回复里回显完整明文
3. 将解出的授权码直接作为 `--auth-code` 传给 `mail163_tool.py`
4. 返回邮件结果，不额外展示完整授权码

## 常见操作

### 查看最近邮件

```bash
python mail163_tool.py --email yourname@163.com --auth-code xxxxx inbox 10
```

### 打开某封邮件

```bash
python mail163_tool.py --email yourname@163.com --auth-code xxxxx read 1234
```

### 发送邮件

```bash
python mail163_tool.py --email yourname@163.com --auth-code xxxxx send someone@example.com "主题" "正文"
```

## 故障排查

### 认证失败

优先检查：

- 邮箱地址是否为正确的 163 邮箱
- 是否使用了客户端授权码，而不是网页登录密码
- 163 邮箱后台是否已开启 IMAP / SMTP
- 授权码是否已失效或被重置

### 搜索失败

163 的 IMAP 搜索对某些关键词兼容性不稳定，尤其是中文关键词。若失败：

1. 先使用 `inbox` 列最近邮件
2. 再按邮件 ID 用 `read` 打开

### 连接失败

检查：

- 是否能访问 `imap.163.com:993`
- 是否能访问 `smtp.163.com:465`
- 当前网络是否拦截 SSL 邮件端口
