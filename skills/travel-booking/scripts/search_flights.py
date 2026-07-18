#!/usr/bin/env python3
"""
航班搜索脚本 - 访问Trip.com和Skyscanner搜索航班
使用方式：python3 search_flights.py --origin "上海" --destination "北京" --date "2026-04-10" --passengers 1
"""

import argparse
import json
from datetime import datetime

def parse_args():
    parser = argparse.ArgumentParser(description='搜索航班')
    parser.add_argument('--origin', required=True, help='出发城市')
    parser.add_argument('--destination', required=True, help='到达城市')
    parser.add_argument('--date', required=True, help='出发日期 YYYY-MM-DD')
    parser.add_argument('--return-date', help='返程日期（往返票）YYYY-MM-DD')
    parser.add_argument('--passengers', type=int, default=1, help='乘客人数')
    parser.add_argument('--platform', default='trip.com', choices=['trip.com', 'skyscanner'], help='搜索平台')
    return parser.parse_args()

def search_flights_trip_com(args):
    """
    搜索Trip.com航班
    注意：此处为演示框架，实际需要集成Trip.com API或使用爬虫
    """
    print(f"搜索Trip.com航班：{args.origin} → {args.destination}")
    print(f"日期：{args.date}, {args.passengers}人")
    
    # TODO: 实际实现需要：
    # 1. 注册Trip.com Affiliate API
    # 2. 使用requests调用API
    # 3. 解析返回JSON数据
    
    # 模拟搜索结果
    results = [
        {
            "airline": "东方航空",
            "flight_number": "MU5101",
            "origin": "上海虹桥 (SHA)",
            "destination": "北京首都 (PEK)",
            "departure_time": "08:30",
            "arrival_time": "10:50",
            "duration": "2小时20分",
            "price": 850,
            "stops": "直飞",
            "aircraft": "A320",
            "booking_url": "https://trip.com/flight/example1"
        },
        {
            "airline": "中国国际航空",
            "flight_number": "CA1502",
            "origin": "上海虹桥 (SHA)",
            "destination": "北京首都 (PEK)",
            "departure_time": "10:15",
            "arrival_time": "12:35",
            "duration": "2小时20分",
            "price": 920,
            "stops": "直飞",
            "aircraft": "B737-800",
            "booking_url": "https://trip.com/flight/example2"
        },
        {
            "airline": "中国南方航空",
            "flight_number": "CZ3566",
            "origin": "上海浦东 (PVG)",
            "destination": "北京大兴 (PKX)",
            "departure_time": "14:40",
            "arrival_time": "17:05",
            "duration": "2小时25分",
            "price": 680,
            "stops": "直飞",
            "aircraft": "A321",
            "booking_url": "https://trip.com/flight/example3"
        },
        {
            "airline": "春秋航空",
            "flight_number": "9C8803",
            "origin": "上海浦东 (PVG)",
            "destination": "北京大兴 (PKX)",
            "departure_time": "06:00",
            "arrival_time": "08:35",
            "duration": "2小时35分",
            "price": 490,
            "stops": "直飞",
            "aircraft": "A320",
            "booking_url": "https://trip.com/flight/example4"
        }
    ]
    
    # 按价格排序
    return sorted(results, key=lambda x: x['price'])

def search_flights_skyscanner(args):
    """
    搜索Skyscanner聚合航班
    注意：此处为演示框架，实际需要集成Skyscanner API
    """
    print(f"搜索Skyscanner航班：{args.origin} → {args.destination}")
    
    # TODO: 实际实现需要：
    # 1. 注册Skyscanner API
    # 2. 使用requests调用API
    
    # 模拟搜索结果
    results = [
        {
            "airline": "吉祥航空",
            "flight_number": "HO1252",
            "origin": "上海虹桥 (SHA)",
            "destination": "北京首都 (PEK)",
            "departure_time": "13:20",
            "arrival_time": "15:40",
            "duration": "2小时20分",
            "price": 780,
            "stops": "直飞",
            "aircraft": "A321",
            "booking_url": "https://skyscanner.com/flight/example1"
        },
        {
            "airline": "厦门航空",
            "flight_number": "MF8523",
            "origin": "上海浦东 (PVG)",
            "destination": "北京大兴 (PKX)",
            "departure_time": "16:50",
            "arrival_time": "19:25",
            "duration": "2小时35分",
            "price": 720,
            "stops": "直飞",
            "aircraft": "B737",
            "booking_url": "https://skyscanner.com/flight/example2"
        }
    ]
    
    return results

def format_results(results):
    """格式化输出结果"""
    print("\n" + "="*100)
    print(f"{'排名':<6}{'航空公司':<15}{'航班号':<12}{'出发':<10}{'到达':<10}{'时长':<12}{'价格':<10}{'中转':<10}")
    print("="*100)
    
    for i, flight in enumerate(results, 1):
        print(f"{i:<6}{flight['airline']:<15}{flight['flight_number']:<12}{flight['departure_time']:<10}"
              f"{flight['arrival_time']:<10}{flight['duration']:<12}¥{flight['price']:<9}{flight['stops']:<10}")
        print(f"      航线：{flight['origin']} → {flight['destination']}, 机型：{flight['aircraft']}")
        print(f"      预订链接：{flight['booking_url']}")
        print("-"*100)
    
    return json.dumps(results, ensure_ascii=False, indent=2)

def main():
    args = parse_args()
    
    # 验证日期格式
    try:
        dep_date = datetime.strptime(args.date, "%Y-%m-%d")
        if args.return_date:
            ret_date = datetime.strptime(args.return_date, "%Y-%m-%d")
            if ret_date <= dep_date:
                print("错误：返程日期必须晚于出发日期")
                return
    except ValueError:
        print("错误：日期格式应为 YYYY-MM-DD")
        return
    
    # 根据平台搜索
    if args.platform == 'trip.com':
        results = search_flights_trip_com(args)
    else:
        results = search_flights_skyscanner(args)
    
    # 输出结果
    json_output = format_results(results)
    
    # 保存到文件
    with open('/tmp/flight_search_results.json', 'w', encoding='utf-8') as f:
        f.write(json_output)
    print(f"\n结果已保存到 /tmp/flight_search_results.json")

if __name__ == '__main__':
    main()
