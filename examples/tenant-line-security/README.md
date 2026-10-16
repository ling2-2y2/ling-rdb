# 租户过滤的 SQL 注入防线

会话租户值是外部输入，可能藏着敌意串。本例逐条演示拦截层的四道防线与
「不支持形态 fail loud」清单。

## 演示内容

- 敌意租户值全程参数化（payload 只落 params，永不进 SQL 文本）
- 词法掩码：字符串字面量内的分号不触发多语句守卫；注释内的伪装谓词不参与定位
- 多语句守卫：顶层分号直接抛错（一次调用一条语句）
- UNION 守卫：第二段涉「未获注入的受控表」抛错；非受控第二段放行
- 规则标识符包装期校验：列/表名只收标识符形态，敌意配置装配即抛
- 左词边界：`tenant_id` 规则不误咬 `f_tenant_id`

## 跑起来

```sh
node --import tsx/esm examples/tenant-line-security/boot.mjs
```

无需真实数据库：语句由 [`examples/_lib`](../_lib/fake-db.mjs) 假库捕获并打印。

对照阅读：README「SQL-injection defenses」与「Unsupported shapes」两章。
