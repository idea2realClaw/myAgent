# 旅游搜索平台API说明

## Trip.com API

### 注册和认证
- 官方文档：https://partners.trip.com/
- 需要申请Partner账号获取API Key
- 支持RESTful API调用

### 酒店搜索API
**Endpoint**: `https://api.trip.com/api/hotels/search`

**请求参数**:
```
{
  "destination": "城市名称",
  "check_in": "YYYY-MM-DD",
  "check_out": "YYYY-MM-DD",
  "guests": 1,
  "rooms": 1,
  "min_rating": 4.5,
  "max_price": 800
}
```

**响应示例**:
```json
{
  "hotels": [
    {
      "hotel_id": "123456",
      "name": "酒店名称",
      "stars": 4,
      "rating": 4.8,
      "price": 650,
      "currency": "CNY",
      "location": {
        "address": "详细地址",
        "latitude": 39.9042,
        "longitude": 116.4074
      },
      "amenities": ["WiFi", "早餐"],
      "images": ["url1", "url2"],
      "booking_url": "https://trip.com/hotel/..."
    }
  ]
}
```

### 航班搜索API
**Endpoint**: `https://api.trip.com/api/flights/search`

**请求参数**:
```
{
  "origin": "出发城市代码",
  "destination": "到达城市代码",
  "departure_date": "YYYY-MM-DD",
  "passengers": 1,
  "cabin_class": "economy|business|first"
}
```

---

## Booking.com API

### 注册和认证
- 官方文档：https://developers.booking.com/
- 需要申请Affiliate Partner账号
- 使用API Key进行认证

### 酒店搜索API
**Endpoint**: `https://distribution-xml.booking.com/json/bookings.getHotelAvailability`

**主要参数**:
- `city_id`: 城市ID
- `check_in`: 入住日期
- `check_out`: 退房日期
- `guests`: 客人数
- `room1`: 房间数量

**特色功能**:
- 实时价格和库存
- 用户评价系统
- 地图位置信息
- 多语言支持

---

## Skyscanner API

### 注册和认证
- 官方文档：https://partners.skyscanner.net/
- 需要申请API Key
- 支持RAPID API集成

### 航班搜索API
**Endpoint**: `https://api.skyscanner.net/api/v1/flights`

**主要功能**:
- 聚合多家航空公司价格
- 日期灵活性搜索
- 附近机场选项
- 价格趋势分析

**价格提醒功能**:
- 设置目标价格
- 自动降价通知
- 历史价格走势

---

## 注意事项

1. **API限流**: 各平台有调用频率限制
2. **认证方式**: 使用API Key或OAuth 2.0
3. **数据准确性**: 价格和库存实时更新
4. **合规要求**: 必须遵守平台使用条款
5. **隐私保护**: 不存储用户个人信息
