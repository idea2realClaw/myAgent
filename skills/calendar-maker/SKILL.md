# calendar-maker Skill

## 功能
根据数据自动生成符合 RFC 5545 标准的 `.ics` 日历文件，支持生日提醒、事件日程等。

## 触发词
- 创建日历、生成日历文件
- 生日提醒、生日日历
- 导出日历、.ics文件
- 批量添加日程

## 使用方法

### 基本用法
```bash
python3 ~/.workbuddy/skills/calendar-maker/scripts/create_calendar.py \
  --name "哥哥生日" --month 7 --day 25 \
  --output birthday.ics
```

### 批量生日
```bash
python3 ~/.workbuddy/skills/calendar-maker/scripts/create_calendar.py \
  --birthday-file birthday.md \
  --output birthdays.ics
```

### 命令行参数
| 参数 | 说明 | 示例 |
|------|------|------|
| `--name` | 事件名称 | "会议"、"生日提醒" |
| `--month` | 月份 | 7 |
| `--day` | 日期 | 25 |
| `--year` | 年份（可选，默认当年） | 2026 |
| `--repeat` | 重复频率 | yearly/monthly/weekly/daily |
| `--birthday-file` | 从Markdown文件读取生日列表 | |
| `--output` | 输出文件路径 | events.ics |

### Markdown 生日列表格式
```markdown
| 姓名 | 月 | 日 | 备注 |
|------|---|---|------|
| 哥哥 | 7 | 25 | |
| 姐姐 | 10 | 31 | |
```
或直接提供日期：
```markdown
| 姓名 | 日期 |
|------|------|
| 哥哥 | 7月25日 |
| 姐姐 | 10月31日 |
```

## 技术要点

### ❌ 禁止手动编写 .ics 文件
- HTML 注释（`<!-- -->`）会导致 macOS 日历解析失败
- 行尾符、格式细节容易出错
- DTSTAMP 时间戳格式要求严格

### ✅ 必须使用 icalendar 库
```python
import icalendar
from icalendar import Event, Calendar
from icalendar.prop import vRecur, vDate
from datetime import date, datetime, timedelta

# 创建日历
cal = Calendar()
cal.add('version', '2.0')
cal.add('prodid', '-//龙木心//Calendar Maker//CN')

# 创建事件
event = Event()
event.add('uid', f'unique-id@domain')
event.add('dtstamp', datetime(2026, 4, 19, 8, 0, 0))
event.add('dtstart', vDate(date(2026, 7, 25)))
event.add('dtend', vDate(date(2026, 7, 26)))
event.add('summary', '事件名称')

# 年度重复
event.add('rrule', vRecur(freq='YEARLY', bymonth=7, bymonthday=25))

cal.add_component(event)

# 写入文件（自动处理RFC 5545格式）
with open('output.ics', 'wb') as f:
    f.write(cal.to_ical())
```

### 关键类型
- `vDate()` - 包装 date 对象，用于全天事件
- `vRecur()` - 创建重复规则，参数 freq/byMonth/byMonthDay
- `datetime()` - 创建 UTC 时间戳的 DTSTAMP

## 依赖
```bash
pip3 install icalendar
```

## 文件结构
```
calendar-maker/
├── SKILL.md
└── scripts/
    └── create_calendar.py
```

## 踩坑记录
- 2026-04-19：macOS 日历无法导入手动编写的 .ics，必须用 icalendar 库
- DTSTAMP 必须是 datetime 对象，不能用字符串
- RRULE 的 freq 必须是字符串如 'YEARLY'
