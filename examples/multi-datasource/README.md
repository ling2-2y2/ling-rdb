# 多数据源

命名多库并存，没有全局「当前库」可切：宿主一行一库，消费者按名字各取
各用。重点是事务换绑——mbp 与 orm 在同一事务连接上原子混写。

## 演示内容

- 注册表：登记名并存、服务键派生（`rdb.database.<名字>`，provider 行按它
  提供生命周期服务）、未知名 fail loud
- 事务混写：`mapper.use(conn)` + `kyselyFor(db, conn)` 同一事务字面量
- 回滚语义：事务体抛错 → 整体回滚并原样上抛
- `withConnection`：无事务但共享同一连接的多语句
- 双库各用：语句各落各库，互不串扰

## 跑起来

```sh
node --import tsx/esm examples/multi-datasource/boot.mjs
```

无需真实数据库：语句由 [`examples/_lib`](../_lib/fake-db.mjs) 假库捕获并打印
（假库按连接记录语句，可验证「同一事务」）。

对照阅读：README「Multi-datasource」一章。
