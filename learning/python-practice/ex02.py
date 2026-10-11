# 练习2：写一个函数 money(x)，把 3.2 变成 "3.20"、160 变成 "160.00"
# 提示：f"{x:.2f}" 表示保留两位小数

def money(x):
    return f"{x:.2f}"


print(money(3.2))    # 3.20
print(money(160))    # 160.00
print(money(6.4))    # 6.40

