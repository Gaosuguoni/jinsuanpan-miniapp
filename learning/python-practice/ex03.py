# 练习3：把 "3块2" 转成 3.2，把 "3块2毛5" 转成 3.25
# 提示：用 s.split("块") 把 "元" 和 "后面的零头" 分开；"毛"=0.1、"分"=0.01
# 额外："3块" → 3.0、"12块5" → 12.5
def kuai_to_num(s):
    if "块" not in s:
        return float(s)


    yuan,rest = s.split("块",1)   # "3块2" → ("3","2")
    value = float(yuan)


    if rest =="":
        return round(value,2)


    if "毛" in rest:              # 形如 "2毛5"
        mao, rest2 = rest.split("毛",1)
        print("调试:", repr(rest),repr(rest2))
        value += int(mao) * 0.1
        if "分" in rest2:
            value += int(rest2.replace("分","")) * 0.01
        elif rest2.isdigit():
            value += int(rest2) * 0.01   
    elif rest.isdigit():           # 形如 "2"
        if len(rest) == 1:
            value += int(rest) * 0.1   # 一位数 = 角
        else:
            value += int(rest) * 0.01  # 两位数 = 分
    return round(value, 2)


print(kuai_to_num("3块2"))
print(kuai_to_num("3块2毛5"))
print(kuai_to_num("3块"))
print(kuai_to_num("12块5"))  