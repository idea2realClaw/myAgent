---
name: travel-booking
description: This skill should be used when users need to search and book hotels, flights, or compare travel options. It provides workflows for searching Trip.com, Booking.com, and similar travel platforms using Python automation, then recommends options based on user preferences.
---

# Travel Booking Skill

酒店机票预订技能。使用Python脚本自动化搜索Trip.com、Booking.com等平台，根据用户偏好推荐最佳选项。

## Skill Purpose

帮助用户高效搜索、比较和预订酒店与航班。支持以下场景：
- 按目的地、日期、预算搜索酒店
- 按行程、时间、价格搜索航班
- 根据用户偏好（星级、评分、位置、价格区间）推荐
- 对比多个平台价格获取最优选择

## When to Use

用户提到以下需求时触发此技能：
- "订酒店"、"找酒店"、"booking"、"住宿"
- "订机票"、"买票"、"flight"、"航班"
- "旅行计划"、"出差住宿"、"行程规划"
- 具体的搜索需求，如"北京到上海的机票"、"三亚的酒店"

## Workflow

### 步骤1：收集需求信息

首先明确以下关键信息：

**酒店搜索必需：**
- 目的地城市或具体区域
- 入住日期、退房日期
- 入住人数/房间数
- 预算范围（如有）

**机票搜索必需：**
- 出发城市、到达城市
- 出发日期、返程日期（往返）或单程日期
- 乘客人数
- 时间偏好（早班/午班/晚班）

**可选偏好：**
- 星级要求（3星/4星/5星）
- 价格敏感度（优先价格/优先舒适）
- 位置偏好（市中心/机场/景区附近）
- 特殊需求（无烟房、免费取消、早餐）

### 步骤2：选择搜索平台

根据搜索类型选择平台：

| 类型 | 平台 | 说明 |
|------|------|------|
| 酒店 | Trip.com | 国际化，中文友好，支持全球酒店 |
| 酒店 | Booking.com | 全球覆盖广，评价系统完善 |
| 机票 | Trip.com | 航班信息全，价格透明 |
| 机票 | Skyscanner | 聚合平台，价格对比 |

### 步骤3：执行Python搜索脚本

调用scripts目录下的Python脚本进行自动化搜索：

**酒店搜索：**
```bash
python3 ~/.workbuddy/skills/travel-booking/scripts/search_hotels.py \
  --platform trip.com \
  --destination "北京" \
  --checkin "2026-04-10" \
  --checkout "2026-04-12" \
  --guests 2 \
  --min-rating 4.5 \
  --max-price 800
```

**机票搜索：**
```bash
python3 ~/.workbuddy/skills/travel-booking/scripts/search_flights.py \
  --platform trip.com \
  --origin "上海" \
  --destination "北京" \
  --date "2026-04-10" \
  --passengers 1
```

### 步骤4：整理推荐结果

将搜索结果按用户偏好排序，生成推荐清单：

**酒店推荐格式：**
| 排名 | 酒店名称 | 星级 | 评分 | 每晚价格 | 位置 | 亮点 |
|------|---------|------|------|---------|------|------|
| 1 | XXX酒店 | ⭐⭐⭐⭐⭐ | 4.8 | ¥650 | 市中心 | 含早餐，免费取消 |

**机票推荐格式：**
| 排名 | 航空公司 | 航班号 | 出发时间 | 到达时间 | 价格 | 中转 |
|------|---------|-------|---------|---------|------|------|
| 1 | 东方航空 | MU5101 | 08:30 | 10:50 | ¥850 | 直飞 |

### 步骤5：提供预订链接

为每个推荐选项提供直接预订链接，方便用户快速下单。

## Bundled Resources Usage

### Scripts

`scripts/search_hotels.py` - 酒店搜索自动化脚本
- 接受命令行参数：目的地、日期、人数、评分、价格范围
- 访问Trip.com/Booking.com API或网页爬取
- 输出结构化JSON结果：名称、价格、评分、位置、预订链接

`scripts/search_flights.py` - 航班搜索自动化脚本
- 接受命令行参数：出发地、目的地、日期、人数
- 访问Trip.com或Skyscanner
- 输出结构化JSON：航班号、时间、价格、航空公司、预订链接

### References

`references/platforms.md` - 各平台API文档和使用说明
- Trip.com API接口说明
- Booking.com搜索参数说明
- Skyscanner聚合平台使用方式

`references/search-tips.md` - 旅行搜索最佳实践
- 提前多久订酒店/机票最便宜
- 如何设置价格提醒
- 淡旺季价格规律

## User Preference Storage

将用户常用偏好存储在本地，提升搜索效率：

- 默认酒店星级偏好
- 常用出发/到达城市
- 预算默认范围
- 常住时间段（工作日/周末）

## Notes

- 所有搜索结果仅提供价格信息和用户评价，不自动完成支付
- 尊重用户隐私，不存储支付信息
- 提醒用户查看取消政策和退改规则
- 对比价格时注意含税/不含税的区别
