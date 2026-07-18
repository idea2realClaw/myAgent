# ventus-booking-monitor Skill

## 用途

监控瑞典大使馆（Ventus/Enalog 系统）护照/签证预约系统，自动检查是否有可用时间段，并发邮件通知。

## 触发词

- 查瑞典大使馆预约
- 检查护照预约
- ventus 预约监控
- 瑞典护照预约
- 大使馆有没有时间
- 帮我查预约
- 预约监控

---

## 关键经验总结（2026-04-05 实战）

### 目标网站

- 预约入口：`https://ventus.enalog.se/Booking/Booking/Index/UDDLondon`
- 系统：Enalog 预约系统（瑞典政府官方供应商）
- 默认语言：瑞典语（Svenska），需手动切换英文

### 完整操作流程（共5步）

| 步骤 | 页面 | 操作 | 关键元素 |
|------|------|------|---------|
| 1 | 首页 | 切换英文 | 点击 `English` 链接（URL含`code=en-GB`） |
| 2 | 首页（英文） | 进入预约 | 点击 `Book an appointment` 按钮 |
| 3 | Agreement 页 | 同意条款 | 勾选 checkbox → 点击 `Next` |
| 4 | Service 页 | 选服务类别 | 点击 `Passport application` → 点击 `Next` |
| 5 | Conditional 页 | 阅读海外居民须知 | 勾选 checkbox → 点击 `Next` |
| 6 | Select time 页 | 查找时间 | 点击 `First available time` 按钮 |

### 时间页面解析规则

时间结果在一个 `<table>` 中，按周显示（Mon–Sun），可用时间格式：

```yaml
- cell "2026-04-07 09:45:00" [ref=eXX]:
  - row "2026-04-07 09:45:00" [ref=eXX] [cursor=pointer]: 09:45
```

**判断逻辑：**
- 有 `cursor=pointer` 的 row 元素 = 有可用时间
- `cell` 中只有空 `[ref=eXX]` = 该天无空位
- 时间格式：`YYYY-MM-DD HH:MM:SS`

**无空位特征：**
- 所有 `cell` 都是空的（无子元素或只有空 generic）
- 整个 rowgroup 下无 `cursor=pointer`

---

## 脚本使用方法

```bash
# 单次检查（打印结果）
python3 ~/.workbuddy/skills/ventus-booking-monitor/scripts/check_booking.py

# 指定不同大使馆地点
python3 ~/.workbuddy/skills/ventus-booking-monitor/scripts/check_booking.py --location UDDLondon

# 找到空位后自动发邮件
python3 ~/.workbuddy/skills/ventus-booking-monitor/scripts/check_booking.py --notify zhuxiaodongzxd@gmail.com

# 定时轮询（每30分钟）
python3 ~/.workbuddy/skills/ventus-booking-monitor/scripts/check_booking.py --notify zhuxiaodongzxd@gmail.com --interval 30
```

---

## 技术细节

### Playwright CLI 路径

```bash
node ~/.workbuddy/plugins/marketplaces/codebuddy-plugins-official/plugins/playwright-cli/playwright-cli.js
```

简写 alias（在脚本中使用）：
```python
PCLI = "node ~/.workbuddy/plugins/marketplaces/codebuddy-plugins-official/plugins/playwright-cli/playwright-cli.js"
```

### 操作序列（命令行）

```bash
# 1. 打开页面
playwright-cli open https://ventus.enalog.se/Booking/Booking/Index/UDDLondon

# 2. 切换英文（找到 English 链接的 ref 后点击）
playwright-cli snapshot --filename=step1.yaml
playwright-cli click e14  # ref 可能变化，需每次从 snapshot 中找

# 3. 点击 Book an appointment
playwright-cli click e49

# 4. 勾选同意 + Next
playwright-cli check e50
playwright-cli click e57

# 5. 选 Passport application + Next
playwright-cli click e50
playwright-cli click e53

# 6. 勾选 Conditional + Next
playwright-cli check e54
playwright-cli click e57

# 7. 点 First available time
playwright-cli click e64

# 8. 获取时间列表
playwright-cli snapshot --filename=times.yaml
```

> ⚠️ 注意：每次打开新 session，元素 ref（e14、e49...）会重新分配。必须先 snapshot 再从 YAML 中动态查找目标元素的 ref，不能硬编码。

### ref 动态查找规则

| 目标 | 搜索关键词 |
|------|-----------|
| 英文切换链接 | `link "English"` 且 url 含 `en-GB` |
| Book appointment 按钮 | `button` 含 `Book` 文字 |
| Agreement checkbox | 第一个 `checkbox` |
| Next 按钮 | `button "Next"` |
| Passport application | `radio` 或 `listitem` 含 `Passport` |
| First available time | `button "First available time"` |
| 可用时间 row | `row` 含 `cursor=pointer` 且文字为 `HH:MM` |

---

## 邮件通知模板

```
主题：🚨 瑞典大使馆护照预约有空位！快去抢！

内容：
- 找到时间：YYYY年M月D日（周X）HH:MM
- 预约链接：https://ventus.enalog.se/Booking/Booking/Index/UDDLondon
- 操作步骤：Book → Agreement → Passport application → Conditional → 选时间 → 填信息
```

---

## 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 元素 ref 找不到 | 每次 session ref 重新分配 | 先 snapshot，动态解析 YAML 找 ref |
| 页面是瑞典语 | 默认语言是 sv-SE | 第一步必须点击 English 切换 |
| 无可用时间 | 系统真的没有空位 | 定时轮询，每 15-30 分钟查一次 |
| checkbox 状态不对 | 已经勾选过再次勾选 | 先 snapshot 确认当前状态 |

---

## 扩展：其他大使馆地点

同一个 Enalog 系统，只需修改 URL 中的地点代码：

```
https://ventus.enalog.se/Booking/Booking/Index/{LOCATION_CODE}
```

已知地点代码：
- `UDDLondon` - 瑞典驻伦敦大使馆
- 其他地点可在官网查找
