# 版本化 DDL 迁移（migrateRdb）

一条 entry 一条 SQL；每个版本给「方言分派组」——MySQL 与 PostgreSQL 各自
专属 DDL，运行器按所连库方言选支（缺支 fail loud）。版本簿记表自动建，
应用过的版本不再重放（幂等）。

## 演示内容

- 方言分派组：中文列注释双方言纪律（MySQL 列内 COMMENT / PG `COMMENT ON`）
- 首轮应用：先建簿记表，再按版本序执行各版本 DDL
- 幂等重放：第二轮业务 DDL 零新增
- `IS_INIT_DB` 总开关（缺省跳过一切初始化任务，示例显式打开）

## 跑起来

```sh
node --import tsx/esm examples/migrations/boot.mjs
```

无需真实数据库：DDL 由 [`examples/_lib`](../_lib/fake-db.mjs) 假库捕获并打印
（假库的簿记钩子模拟版本表回放）。

对照阅读：README「Migrations」一章。改表结构只改 MySQL 原文件后重新生成
PG 副本的树内纪律见 bsh 树 AGENTS.md §二。
