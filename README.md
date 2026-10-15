# dsh-rdb

关系数据库公共层（Service Definition）：`ctx.rdb` hub + 命名数据库注册表 + 事务门面 + 有序 DDL 迁移器。供 bsh-scratch-plugin 内其他插件（会话持久化、用户管理……）共享，自身不做任何 IO——池与驱动由提供者（如 `dsh-rdb-mysql`）拥有。

## 形态

- `ctx.rdb.database` — 命名注册表（`register(name, db)` 返回 disposer；重名 throw；`get(name)` 未知名 throw 并列出现有名）。多库并存，哪个消费者用哪个库是消费者配置，不是 hub 全局选择。
- `rdbDatabaseServiceKey(name)` — 防激活竞态的生命周期 key。提供者 `ctx.provide` 该 key；消费者 `[Service.init]` 里 `ctx.inject([key], …)` 建栅栏，行序颠倒也不会竞态。
- `RdbDatabase` — 一个命名数据库的门面：`query`（客户端插值，DDL/动态 VALUES 用）/ `execute`（预处理，返回 `{affectedRows, insertId}`）/ `withConnection`（借还托底）/ `transaction`（begin → work → commit；work 抛错 rollback 后重抛，rollback 也失败则 `AggregateError`）/ `close`（幂等）。`identity` 给出物理库稳定标识（如 `mysql:host:3306/db`），供消费者嵌入 revision。
- `migrateRdb(database, {table, migrations})` — 版本表 + 有序 DDL 执行器：建 `CREATE TABLE IF NOT EXISTS` 版本表 → 按版本升序应用未执行迁移 → 每版成功即记行。不生成 SQL，语句归消费者所有。

## 语句构建工具（`src/query.ts`，纯函数，无 IO）

消费者 statements 文件的公共脚手架沉淀于此，产出与原手写常量**逐字节一致**的 SQL 文本（仍走 `db.query/execute`，可审计性不变）：

- `rdbTableColumns({data, audit?, extra?, idColumn?, tenantColumn?})` — 列清单拼装：`f_id` + 数据列 + 审计尾（默认四列，可换 creator-only/空）+ 附加列（如 `f_delete_mark`）+ `f_tenant_id`。SELECT 投影与 INSERT 列序的单一事实源。
- `rdbTableStatements({table, columns, insertColumns?, tenantColumn?})` — 四条固定模板：`select` / `selectById` / `insert` / `deleteById`。
- `inFragment(column, values)` — `col IN (?, …)`；空列表渲染 `1 = 0`。
- `buildRdbListQuery(spec)` — 声明式分页列表：条件按序拼接（`eq` 值为 `undefined` 即跳过；`keyword` 空串跳过、`keepEmpty` 复刻 Ling 只判 `!== undefined` 的怪癖；`raw` 供不可参数化的固定片段；`tenant` 恒为 `f_tenant_id = ?`），ORDER 支持 keyword 激活时追加 tie-breaker，分页 `LIMIT ? OFFSET ?` 仅在有 pageSize 时追加；同时返回共享 WHERE 的 COUNT 孪生（无 ORDER/LIMIT，分页参数不入孪生）。

业务插件准则：**CRUD 脚手架先用此 kit，装不进去的再手写**——禁止在消费者里重抄列清单拼装/列表构建器模板（见 `.claude/skills/dsh-crud/SKILL.md`）。

## 租户行拦截（`src/tenant-line.ts`，Ling `BasicTenantInnerInterceptor`/`BasicTenantHandler` 对应物）

MyBatis-Plus 的行拦截器在执行期给 SQL 追加租户条件；dsh 消费者语句已内联该条件，本模块退化为**执行期换绑定值**——语句文本与 `?` 位置归语句方所有，模块只识别与替换参数：

- `runWithTenantLine({tenantId, filter}, fn)` / `currentTenantLine()` / `ignoreTenantLine(fn)` — AsyncLocalStorage 请求作用域（线程槽 + `@TenantIgnore` 对应物），沿 await 链传播，嵌套可覆盖。
- `wrapTenantLineDatabase(db, {column, tables})` — 包装任意 `RdbDatabase` 形状（含测试假外观）：`query`/`execute`/`transaction`/`withConnection` 全路径上，受控表（`tables`，`EXCLUDE_TABLES` 对应物——清单外表的 `f_tenant_id` 可能是属主引用而非分区）的 `列 = ?` 谓词与 INSERT…VALUES 列位改写为会话租户；上下文缺席/`filter:false`/豁免位时原样透传。方言无关，提供者无需参与。
- 上下文数据从哪来是业务侧的事（dsh-admin 经 dsh-cache 会话记录解析后注入）——本模块不碰缓存、不碰身份。

## 约定（README 固化，接口不强制）

- **占位符**：消费者一律写 `?`；非 `?` 方言（postgres `$n`）由提供者重写。
- **类型编组**：JSON 列由消费者 codec 负责；datetime 由提供者透传驱动值，消费者自行归一；BigInt 消费者 `Number()`。
- **标识符**：表名/列名消费者自持（`base_user`、`dsh_sessions` 直接写死在各自 statements 文件）。

## 迁移器注意

MySQL DDL 自带隐式提交：一条多语句版本失败时可能残留部分 DDL 且无版本行。恢复 = 人工修复后重跑（fail loud，不猜）。会话持久化插件刻意不用迁移器（保持 `CREATE TABLE IF NOT EXISTS` 幂等路径）。

## 测试

```sh
cd scratch-plugin/bsh-scratch-plugin/dsh-rdb
npx vitest run   # 纯内存 fake，无需服务器
```
