# orm 语句构造层（Kysely）

复杂查询走 `kyselyFor`，语句仍全部经数据库门面执行（池 / 事务 / 租户包装
零旁路）。入口 `@ling2/ling-rdb/orm`（或根出口 re-export）。

## 演示内容

- 一条真的复杂查询：三表 JOIN（条件复合进 ON）+ 条件聚合（CASE WHEN 求和）
  + GROUP BY + HAVING + 聚合别名排序 + 分页；参数序 ON → WHERE → HAVING → LIMIT → OFFSET
- 写三通道：INSERT 走 query 通道、UPDATE / DELETE 走 execute 通道（`numUpdatedRows` 计数保真）
- 构造器覆盖不到的形态（相关子查询）走 `sql` 模板逃生口（`${}` 值仍参数绑定）
- 事务绑定：`kyselyFor(db, conn)` 与外层 `transaction` 同一连接，可与
  `mapper.use(conn)` 混写

## 跑起来

```sh
node --import tsx/esm examples/orm-queries/boot.mjs
```

无需真实数据库：语句由 [`examples/_lib`](../_lib/fake-db.mjs) 假库捕获并打印。

对照阅读：README「orm statement layer」一章。
