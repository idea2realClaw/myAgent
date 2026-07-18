# Shared Secret Crypto 参考说明

## 兼容范围

本 Skill 与以下方式生成的密文兼容：

- `C:\Users\zhuxi\WorkBuddy\Claw\crypto-tool\crypto.html`
- `CryptoJS.AES.encrypt(plainText, sharedKey).toString()`
- OpenSSL 风格 `Salted__` 头 + MD5 派生 key/iv 的 AES-CBC 结果

常见密文外观：

- Base64 字符串
- 常以 `U2FsdGVkX1` 开头

## 命令示例

### 解密

```bash
python C:\Users\zhuxi\.workbuddy\skills\shared-secret-crypto\scripts\crypto_secret.py decrypt --cipher "U2FsdGVkX1..." --key "<共享密钥>"
```

### 加密

```bash
python C:\Users\zhuxi\.workbuddy\skills\shared-secret-crypto\scripts\crypto_secret.py encrypt --text "my-password" --key "<共享密钥>"
```

### 用环境变量传密钥

```bash
set SHARED_SECRET_CRYPTO_KEY=<共享密钥>
python C:\Users\zhuxi\.workbuddy\skills\shared-secret-crypto\scripts\crypto_secret.py decrypt --cipher "U2FsdGVkX1..."
```

## 推荐使用方式

### 1. 解密后立即使用

适合 Gmail、API、SSH、网页登录等场景。

原则：

- 明文只在本次任务运行时存在
- 优先在内存中传递给后续命令
- 完成后不写入脚本默认值或普通文档

### 2. 仅在必要时展示明文

若用户真实需求只是“用它干活”，则：

- 可以不回显完整明文
- 只回报任务是否成功、返回结果是否正常
- 若需要复核，可展示部分遮罩值

### 3. 需要长期保存时先确认

只有在用户明确要求“记住这个密钥 / 密码 / token”时，才允许写入长期记忆或配置。

## 常见问题

### 解密失败，请检查密钥是否正确

可能原因：

- 共享密钥不对
- 密文不是由兼容算法生成
- 密文被复制时缺字或多字

### 运行时报缺少 Crypto 模块

安装：

```bash
pip install pycryptodome
```

## 安全原则

- 不把解密后的明文发到 BBS、论坛、网页或公共聊天内容
- 不把明文写入脚本默认值、仓库代码、示例截图
- 不把共享密钥随 Skill 一起公开分发给陌生人
- 用户只要求“使用”时，优先执行任务而不是展示密钥内容
