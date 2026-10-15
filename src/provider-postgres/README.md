# dsh-rdb-postgres — PostgreSQL provider（dsh-rdb hub）

原生 PG wire 协议，官方 `pg` 驱动（8.23.0）直连。`RdbDatabase` 契约形态镜像 `dsh-rdb-mysql`/`dsh-rdb-kingbase`；方言名归位 hub 联合类型既有的 `'postgresql'` 位（dsh-orm `kyselyFor` 已按它分派 PG 方言编译器）。

## 机制要点

- **占位符**：语句层统一 `?`，传输层翻译为 `$1,$2…`（`src/translate.ts`，复用 `dsh-rdb/src/placeholders`）
- **连接**：`postgres://user:pwd@host:port/dbname`；门面级 query/execute 走 `pool.query`（单语句自动取还），`withConnection`/事务持有独占 client（BEGIN/COMMIT/ROLLBACK）
- **写结果**：`rowCount` → affectedRows；insertId 恒 0（自增/默认值经 `RETURNING` 取）
- **migrateRdb**：版本表 DDL（`CREATE TABLE IF NOT EXISTS … BIGINT PRIMARY KEY`）与 `?` 占位符在 PG 全可移植，**零改动**
- **实例缺席勿挂行**：eager open 拒启动（oracle/dm/kingbase 门控壳同一纪律）

## 首个消费方与实例

dsh-aip **weknora 复刻子系统**（库 `dsh_weknora`）→ ParadeDB 发行版 PG 17.9 @ `192.168.74.129:5432`（WeKnora 源栈同款镜像 `paradedb/paradedb:v0.22.6-pg17`；`pg_search`/`vector`/`pg_trgm`/`uuid-ossp` 扩展齐备，weknora V1 基线 DDL 依赖）。建库带外：

```sh
DSH_POSTGRES_ADMIN_URL='postgres://user:pwd@192.168.74.129:5432/postgres' \
node scripts/create-database.mjs
```

## 安装与测试

```sh
cd dsh-rdb-postgres && pnpm install --ignore-workspace --config.auto-install-peers=false
npx vitest run   # translate 纯单测；门控壳缺环境变量自动 skip
DSH_POSTGRES_URL='postgres://user:pwd@host:5432/dsh_weknora' npx vitest run   # 真连八用例
```
