# 练习1：用变量存一笔账（类型/品名/数量/单价），计算总额并打印
# 目标输出：进货 苹果 50斤 × 3.2 = 160.0 元

type_ = "进货"
name = "苹果"
qty = 50
unit = "斤"
price = 3.2


total = qty * price


print(f"{type_} {name} {qty}{unit} * {price} = {total}元")