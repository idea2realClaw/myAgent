#!/usr/bin/env python3
"""
日历文件生成器 - 使用 icalendar 库生成符合 RFC 5545 标准的 .ics 文件
"""

import argparse
import os
import re
import sys
from datetime import date, datetime, timedelta
from typing import List, Tuple

try:
    import icalendar
    from icalendar import Event, Calendar
    from icalendar.prop import vRecur, vDate
except ImportError:
    print("错误：需要安装 icalendar 库")
    print("执行: pip3 install icalendar")
    sys.exit(1)


def parse_date_string(date_str: str) -> Tuple[int, int]:
    """从字符串解析月和日"""
    # 支持格式：7月25日、7/25、07/25、7-25
    patterns = [
        r'(\d{1,2})[月/-](\d{1,2})',  # 7月25日 或 7/25 或 7-25
        r'^(\d{1,2})$',  # 只有数字，假设是日
    ]
    
    for pattern in patterns:
        match = re.search(pattern, date_str)
        if match:
            if len(match.groups()) == 2:
                return int(match.group(1)), int(match.group(2))
    
    raise ValueError(f"无法解析日期: {date_str}")


def parse_markdown_birthdays(md_content: str) -> List[Tuple[str, int, int]]:
    """从 Markdown 表格解析生日列表"""
    birthdays = []
    lines = md_content.strip().split('\n')
    
    for line in lines:
        line = line.strip()
        if not line or not line.startswith('|'):
            continue
        
        # 跳过表头和分隔符
        if '---' in line or '| 姓名' in line or '|名称' in line:
            continue
        
        parts = [p.strip() for p in line.split('|')]
        if len(parts) < 3:
            continue
        
        name = parts[1]
        date_part = parts[2]
        
        # 尝试解析日期
        try:
            # 如果是 "7月25日" 或 "7/25" 格式
            month, day = parse_date_string(date_part)
            birthdays.append((name, month, day))
        except ValueError:
            # 尝试整行作为日期
            try:
                month, day = parse_date_string(line)
                birthdays.append((name, month, day))
            except ValueError:
                continue
    
    return birthdays


def create_single_event(name: str, month: int, day: int, 
                        event_type: str = "event",
                        year: int = None) -> Event:
    """创建单个事件"""
    if year is None:
        year = date.today().year
    
    event = Event()
    event.add('uid', f'{name}-{event_type}@{datetime.now().strftime("%Y%m%d%H%M%S")}@calendarmaker')
    event.add('dtstamp', datetime.now())
    event.add('dtstart', vDate(date(year, month, day)))
    event.add('dtend', vDate(date(year, month, day) + timedelta(days=1)))
    event.add('summary', f'{name}{event_type}')
    
    # 年度重复（生日默认每年重复）
    if event_type == "生日":
        event.add('rrule', vRecur(freq='YEARLY', bymonth=month, bymonthday=day))
    
    return event


def create_calendar_from_birthdays(birthdays: List[Tuple[str, int, int]], 
                                  title: str = "日历事件") -> Calendar:
    """从生日列表创建日历"""
    cal = Calendar()
    cal.add('version', '2.0')
    cal.add('prodid', '-//龙木心//Calendar Maker//CN')
    
    for name, month, day in birthdays:
        event = create_single_event(name, month, day, "生日")
        cal.add_component(event)
    
    return cal


def main():
    parser = argparse.ArgumentParser(description='生成 .ics 日历文件')
    parser.add_argument('--name', help='事件名称')
    parser.add_argument('--month', type=int, help='月份')
    parser.add_argument('--day', type=int, help='日期')
    parser.add_argument('--year', type=int, help='年份（默认当年）')
    parser.add_argument('--repeat', default='yearly', 
                       choices=['yearly', 'monthly', 'weekly', 'daily'],
                       help='重复频率')
    parser.add_argument('--birthday-file', help='从 Markdown 文件读取生日列表')
    parser.add_argument('--output', '-o', default='calendar.ics', help='输出文件')
    
    args = parser.parse_args()
    
    birthdays = []
    
    # 从文件读取
    if args.birthday_file:
        if not os.path.exists(args.birthday_file):
            print(f"错误：文件不存在 {args.birthday_file}")
            sys.exit(1)
        
        with open(args.birthday_file, 'r', encoding='utf-8') as f:
            content = f.read()
        
        birthdays = parse_markdown_birthdays(content)
        print(f"从 {args.birthday_file} 解析到 {len(birthdays)} 个生日")
    
    # 单个事件
    elif args.name and args.month and args.day:
        birthdays = [(args.name, args.month, args.day)]
    
    else:
        parser.print_help()
        print("\n示例：")
        print("  单个事件: create_calendar.py --name '会议' --month 6 --day 15")
        print("  生日列表: create_calendar.py --birthday-file birthdays.md")
        sys.exit(1)
    
    # 创建日历
    cal = create_calendar_from_birthdays(birthdays, "生日提醒")
    
    # 写入文件
    with open(args.output, 'wb') as f:
        f.write(cal.to_ical())
    
    print(f"✓ 生成 {args.output}，共 {len(birthdays)} 个事件")
    print(f"  事件列表：")
    for name, month, day in birthdays:
        print(f"    - {name}: {month}月{day}日")


if __name__ == '__main__':
    main()
