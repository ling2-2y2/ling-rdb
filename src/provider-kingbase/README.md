# dsh-rdb-kingbase — 金仓 KingbaseES provider（dsh-rdb hub）

金仓说 PostgreSQL wire 协议——官方 `pg` 驱动（8.23.0）直连（改 host/port 即可），`PostgresAdapter` 语义同 PG。`RdbDatabase` 契约形态镜像 `dsh-rdb-mysql`。

## 机制要点

- **占位符**：语句层统一 `?`，传输层翻译为 `$1,$2…`（`src/translate.ts`，复用 `dsh-rdb/src/placeholders`）
- **连接**：`postgres://user:pwd@host:port/dbname` 原生可读；门面级 query/execute 走 `pool.query`（单语句自动取还），`withConnection`/事务持有独占 client（BEGIN/COMMIT/ROLLBACK）
- **写结果**：`rowCount` → affectedRows；insertId 恒 0（Ling 表全部应用侧赋 id）
- **类型**：`@types/pg` devDep

## PoC 待办（实例到位后）

- 金仓 `sql_compatibility` 模式确认（决定协议/方言细节）
- `DSH_KINGBASE_URL=postgres://user:pwd@host:port/dbname npx vitest run`（五用例门控壳）

## 安装与测试

```sh
cd dsh-rdb-kingbase && pnpm install --ignore-workspace --config.auto-install-peers=false
npx vitest run   # translate 纯单测；门控壳缺环境变量自动 skip
```
