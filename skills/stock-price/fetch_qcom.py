from stock_price_tool import StockPriceFetcher

fetcher = StockPriceFetcher()

# 查询QCOM
result = fetcher.get_stock_price('QCOM')
print(fetcher.format_price_output(result))
