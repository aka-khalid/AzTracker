import sys

with open("worker.js", "r", encoding="utf-8") as f:
    code = f.read()

code = code.replace("p.product_name", "p.name")
code = code.replace("product_name,", "name,")
code = code.replace("product_name =", "name =")
code = code.replace("excluded.product_name", "excluded.name")

with open("worker.js", "w", encoding="utf-8") as f:
    f.write(code)
