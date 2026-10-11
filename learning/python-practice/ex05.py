# 练习5：用列表存 5 笔账，循环打印每一笔
#
# 提示：
#   bills = [
#       {"name": "苹果", "total": 160},
#       {"name": "白菜", "total": 60},
#   ]
#   for b in bills:
#       print(b["name"], b["total"])
#
# 目标输出（示例）：
#   苹果 160 元
#   白菜 60 元
#   ...
#
# 进阶（选做）：在循环里累加总金额，最后打印
#   今天共 5 笔，合计 400 元

bills = [
    {"name": "苹果", "total": 160},
    {"name": "白菜", "total": 60},
    {"name": "土豆", "total": 80},
    {"name": "茄子", "total": 50},
    {"name": "西红柿", "total": 90},
]

total_sum = 0
for b in bills:
    print(b["name"],b["total"],"元")
    total_sum += b["total"]


print("今天共",len(bills),"笔, 合计", total_sum, "元")
