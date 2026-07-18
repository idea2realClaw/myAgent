#!/usr/bin/env python3
"""
酒店搜索脚本 - 访问Trip.com和Booking.com搜索酒店
使用方式：python3 search_hotels.py --destination "北京" --checkin "2026-04-10" --checkout "2026-04-12" --guests 2 --min-rating 4.5 --max-price 800
"""

import argparse
import json
from datetime import datetime

def parse_args():
    parser = argparse.ArgumentParser(description='搜索酒店')
    parser.add_argument('--destination', required=True, help='目的地城市')
    parser.add_argument('--checkin', required=True, help='入住日期 YYYY-MM-DD')
    parser.add_argument('--checkout', required=True, help='退房日期 YYYY-MM-DD')
    parser.add_argument('--guests', type=int, default=1, help='入住人数')
    parser.add_argument('--platform', default='trip.com', choices=['trip.com', 'booking.com'], help='搜索平台')
    parser.add_argument('--min-rating', type=float, default=0, help='最低评分')
    parser.add_argument('--max-price', type=float, default=None, help='最高每晚价格')
    return parser.parse_args()

def search_hotels_trip_com(args):
    """
    搜索Trip.com酒店
    注意：此处为演示框架，实际需要集成Trip.com API或使用爬虫
    """
    print(f"搜索Trip.com酒店：{args.destination}")
    print(f"入住：{args.checkin}, 退房：{args.checkout}, {args.guests}人")
    
    # TODO: 实际实现需要：
    # 1. 注册Trip.com Affiliate API
    # 2. 使用requests调用API
    # 3. 解析返回JSON数据
    
    # 模拟搜索结果
    results = [
        {
            "name": "北京国贸大酒店",
            "stars": 5,
            "rating": 4.8,
            "price": 650,
            "location": "朝阳区，CBD核心区",
            "highlights": ["含早餐", "免费取消", "地铁直达"],
            "booking_url": "https://trip.com/hotel/example1"
        },
        {
            "name": "北京王府井希尔顿酒店",
            "stars": 4,
            "rating": 4.6,
            "price": 720,
            "location": "东城区，王府井商圈",
            "highlights": ["免费取消", "行政酒廊"],
            "booking_url": "https://trip.com/hotel/example2"
        },
        {
            "name": "北京三里屯亚朵S酒店",
            "stars": 4,
            "rating": 4.9,
            "price": 550,
            "location": "朝阳区，三里屯",
            "highlights": ["含早餐", "免费WiFi", "智能客房"],
            "booking_url": "https://trip.com/hotel/example3"
        }
    ]
    
    # 根据评分和价格筛选
    filtered = [r for r in results if r['rating'] >= args.min_rating]
    if args.max_price:
        filtered = [r for r in filtered if r['price'] <= args.max_price]
    
    return filtered

def search_hotels_booking_com(args):
    """
    搜索Booking.com酒店
    注意：此处为演示框架，实际需要集成Booking.com API或使用爬虫
    """
    print(f"搜索Booking.com酒店：{args.destination}")
    
    # TODO: 实际实现需要：
    # 1. 注册Booking.com Affiliate API
    # 2. 使用requests调用API
    
    # 模拟搜索结果
    results = [
        {
            "name": "北京首都机场希尔顿酒店",
            "stars": 4,
            "rating": 4.7,
            "price": 680,
            "location": "顺义区，机场T3航站楼",
            "highlights": ["免费接送", "含早餐"],
            "booking_url": "https://booking.com/hotel/example1"
        },
        {
            "name": "北京长城脚下公社",
            "stars": 3,
            "rating": 4.5,
            "price": 420,
            "location": "怀柔区，长城脚下",
            "highlights": ["免费停车", "含早餐"],
            "booking_url": "https://booking.com/hotel/example2"
        }
    ]
    
    return results

def format_results(results):
    """格式化输出结果"""
    print("\n" + "="*80)
    print(f"{'排名':<6}{'酒店名称':<25}{'星级':<8}{'评分':<8}{'价格':<12}{'位置':<15}")
    print("="*80)
    
    for i, hotel in enumerate(results, 1):
        stars_str = "⭐" * hotel['stars']
        print(f"{i:<6}{hotel['name']:<25}{stars_str:<8}{hotel['rating']:<8}¥{hotel['price']:<11}{hotel['location']:<15}")
        print(f"      亮点：{', '.join(hotel['highlights'])}")
        print(f"      预订链接：{hotel['booking_url']}")
        print("-"*80)
    
    # 输出JSON以便程序调用
    return json.dumps(results, ensure_ascii=False, indent=2)

def main():
    args = parse_args()
    
    # 验证日期格式
    try:
        checkin_date = datetime.strptime(args.checkin, "%Y-%m-%d")
        checkout_date = datetime.strptime(args.checkout, "%Y-%m-%d")
        if checkout_date <= checkin_date:
            print("错误：退房日期必须晚于入住日期")
            return
    except ValueError:
        print("错误：日期格式应为 YYYY-MM-DD")
        return
    
    # 根据平台搜索
    if args.platform == 'trip.com':
        results = search_hotels_trip_com(args)
    else:
        results = search_hotels_booking_com(args)
    
    # 输出结果
    json_output = format_results(results)
    
    # 保存到文件
    with open('/tmp/hotel_search_results.json', 'w', encoding='utf-8') as f:
        f.write(json_output)
    print(f"\n结果已保存到 /tmp/hotel_search_results.json")

if __name__ == '__main__':
    main()
