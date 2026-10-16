# ling-rdb

A **relational database hub** for cordis-based TypeScript hosts: mount one or many named databases on `ctx.rdb`, run versioned DDL migrations, and do your data access through two complementary layers — a MyBatis-Plus-style semantic layer (`mbp`) for single-table CRUD and a Kysely statement-builder layer (`orm`) for complex queries. Ships with a dialect kit (placeholders, upsert rendering, paged-list builder, tenant predicate) and five provider plugins: mysql, postgres, oracle, dm (达梦), kingbase (金仓).

> 简体中文文档见 [README.zh-CN.md](./README.zh-CN.md)。

## Features

- **Hub, not IO** — `ctx.rdb` is a named database registry; providers own pools and drivers, consumers resolve by name.
- **Migrations** — `migrateRdb(db, { table, migrations })`: versioned DDL runner with an auto-created bookkeeping table; a broken chain fails loud (one entry = one SQL statement).
- **mbp semantic layer** — one table descriptor + one `BaseMapper` covers full single-table CRUD: audit columns stamped automatically, logical-delete bit, type-driven row mapping, paged double-query, typed wrappers, tenant/fill ALS seams.
- **orm statement layer** — Kysely 0.29.5 (exact pin) driver facade with dialect compilers for mysql / postgresql / oracle / dm (+ kingbase on the postgres wire); explicit transaction facade; streaming queries fail honest.
- **Dialect kit** — numbered-placeholder translation (`?`→`$n`/`:n`, quote-aware), structured upsert / insert-ignore rendering plus MySQL text adaptation, declarative paged-list builder, tenant row predicate, JSON column codec.
- **Five provider plugins** — mysql/postgres resident; oracle/dm/kingbase gated shells (don't mount a row without an instance: eager pool bootstrap fails loud).

## Install

```sh
npm install @ling2/ling-rdb
# peer: @ling2/ling-cordis ^2.0.0
```

## Quick start

```ts
import { migrateRdb, defineTable, BaseMapper, numberedPlaceholders, upsertSql } from '@ling2/ling-rdb'

// migrations: versioned DDL, one entry = one statement
await migrateRdb(db, { table: 'demo_kv', migrations: [...] })

// mbp: descriptor → mapper → typed CRUD
const KvMapper = new BaseMapper(defineTable({...}))

// dialect kit: pure functions, zero connections
const sql = numberedPlaceholders('INSERT INTO demo_kv VALUES (?, ?)', 'postgres')
```

Provider plugins mount through cordis: one config row = one named database with its own pool (eager, fail-loud bootstrap).

## Structure

```text
src/
├── index.ts        # aggregate root (hub service + re-exports; default = Rdb)
├── hub/            # registry, transport contracts, migration runner, error type
├── kit/            # dependency-free dialect kit (placeholders/upsert/list-query/tenant/JSON)
├── mbp/            # MyBatis-Plus-style semantic layer
├── orm/            # Kysely statement-builder layer (dialect compilers)
└── provider-*/     # five dialect provider plugins (mysql/postgres/oracle/dm/kingbase)
```

## mbp semantic layer (single-table CRUD)

One table descriptor + one `BaseMapper` covers the full single-table lifecycle. Audit columns, logical delete, tenant partition and type-driven row mapping are all derived from the descriptor — write paths stamp unconditionally and cannot be skipped. The shapes below mirror the `portal` domain repository of `ling-dsh-admin-pro`.

### Declare the table

```ts
import { defineTable } from '@ling2/ling-rdb'

// 列定义顺序即物理列序；id → 数据列 → 审计尾 → 逻辑删 → 租户由描述符派生
const PORTAL_TABLE = defineTable({
  table: 'demo_portal',
  id: 'f_id',
  tenant: 'f_tenant_id',       // 租户分区列；null = 无分区（登记表类）
  audit: true,                 // 审计四列尾（creator / last_modify 对）
  deleteMark: 'f_delete_mark', // 逻辑删位；null = 硬删
  columns: {
    fullName: { column: 'f_full_name' },
    enCode: { column: 'f_en_code' },
    category: { column: 'f_category', nullable: true },
    type: { column: 'f_type', type: 'int', nullable: true },
    sortCode: { column: 'f_sort_code', type: 'int', nullable: true },
    enabledMark: { column: 'f_enabled_mark', type: 'bool', nullable: true },
  },
})
```

### Construct the mapper (forced fill)

```ts
import { BaseMapper, currentMbpFill } from '@ling2/ling-rdb'
import type { RdbDatabase } from '@ling2/ling-rdb'

// database = 任意 MbpExecutor（RdbDatabase 或事务连接）；fill 缺省读 ALS 作用域
const mapper = new BaseMapper<PortalRecord>(PORTAL_TABLE, {
  database: db as RdbDatabase,
  fill: () => ({
    operatorId: currentMbpFill()?.operatorId ?? null,
    tenantId: currentTenantId(),   // 或任一租户来源
  }),
})
```

Request scope: inside `runWithMbpFill({ operatorId, tenantId }, …)` every mapper write stamps automatically — `insert` emits `id + creator pair + delete-mark + tenant`, `updateById` appends the `last_modify` pair. A caller cannot skip stamping; with no scope at all the values fall to `null` (no crash, no guessing):

```ts
import { runWithMbpFill } from '@ling2/ling-rdb'

const created = await runWithMbpFill({ operatorId: 'op-1', tenantId: '000000' }, () =>
  mapper.insert({ fullName: '工作台门户', enCode: 'workbench' }))
// INSERT 列序（全派生）：f_id → 数据列 → 审计四列 → f_delete_mark → f_tenant_id
```

### CRUD verbs

```ts
await mapper.selectById(id)                       // 未删 + 租户谓词自动前置；类型驱动行映射
await mapper.selectBy('enCode', 'workbench')      // 按非主键列等值读一行
await mapper.updateById(id, { sortCode: 2 })      // SET 白名单 = 描述符列（未知字段 fail loud）
await mapper.deleteById(id)                       // 逻辑删表 → UPDATE mark=1；硬删表 → DELETE
await mapper.saveOrUpdate(entity)                 // 有 id 走更新、无 id 走插入（Ling 分流语义）
await mapper.selectByIds([id1, id2])              // IN + 未删 + 租户
await mapper.existsBy('enCode', 'x', { excludeId: id })  // 编辑判重
await mapper.deleteByIds([id1, id2])              // 批量逻辑删（Ling deleteLogic 语义）
```

### Typed wrapper + paged double query

```ts
import { mbpWrapper } from '@ling2/ling-rdb'

const conditions = mbpWrapper(PORTAL_TABLE)
  .eq('type', 0)                                  // undefined 自动跳过（「传了才生效」）
  .keyword(['fullName', 'enCode'], keyword)       // (a LIKE ? OR b LIKE ?)
  .rawCmp('f_creator_time', '>=', '2026-01-01')   // 描述符外列逃生口（列名须固定字面量）
  .build()

const page = await mapper.selectPage({ page: 1, pageSize: 20, conditions, order: ['f_sort_code ASC'] })
// COUNT 与 SELECT 共享 WHERE；租户/未删谓词由 mapper 自动前置，参数序 = 谓词出现序
page.total // → count
page.items // → decoded records
```

### Raw SQL + row mapping

Hand-written statements stay first-class for complex queries and aggregates; map driver rows back through the descriptor so the physical/record boundary stays single-sourced:

```ts
import { decodeRowWith } from '@ling2/ling-rdb'

const rows = await db.query<Record<string, unknown>>(
  'SELECT * FROM demo_portal WHERE f_en_code = ? AND f_tenant_id = ?', ['workbench', tenantId])
const record = rows[0] === undefined ? undefined : decodeRowWith<PortalRecord>(PORTAL_TABLE, rows[0])
```

Transactions rebind the mapper onto the transaction connection with `mapper.use(conn)` — see [Multi-datasource → Transactions](#transactions).

## orm statement layer (complex queries)

Kysely 0.29.5 (exact pin) behind `kyselyFor(database)`: dialect compilers for mysql / postgresql / kingbase / oracle / dm, and every statement still flows through the database facade (pool / transaction / tenant wrapper zero bypass). Kysely itself is never imported bare — the package re-exports `sql` and the types.

```ts
import { kyselyFor, sql } from '@ling2/ling-rdb'

const ky = kyselyFor(database) // 方言按 database.dialect 分派；未支持方言 fail loud

// 复杂查询：三表 JOIN（条件复合进 ON）+ 条件聚合 + GROUP BY + HAVING + CASE WHEN + 分页
const rows = await ky
  .selectFrom('demo_portal as p')
  .innerJoin('demo_portal_data as d', join =>
    join.onRef('d.f_portal_id', '=', 'p.f_id').on('d.f_type', '=', 'RELEASE'))
  .innerJoin('base_user as u', 'u.f_id', 'p.f_creator_user_id')
  .select(eb => [
    'p.f_id',
    'p.f_full_name',
    'u.f_full_name as creator_name',
    eb.fn.count('d.f_id').as('snapshot_count'),                       // 发布快照数
    eb.fn.max('d.f_last_modify_time').as('last_release_at'),          // 最近发布时间
    eb.fn.sum(eb.case().when('p.f_state', '=', 1).then(1).else(0).end())
      .as('released_count'),                                          // 已发布标志聚合
  ])
  .where('p.f_tenant_id', '=', tenantId)
  .where('p.f_enabled_mark', '=', 1)
  .groupBy(['p.f_id', 'p.f_full_name', 'u.f_full_name'])
  .having(eb => eb.fn.count('d.f_id'), '>=', 2)
  .orderBy('last_release_at', 'desc')
  .limit(20)
  .offset(0)
  .execute()

// 写：insert 走 query 通道（INSERT..RETURNING 需行集回传）；update/delete 走
// execute 通道——写计数位保真，numUpdatedRows 不会恒 0
await ky.insertInto('demo_portal').values({ f_full_name: 'x', f_tenant_id: tenantId }).execute()
const result = await ky.updateTable('demo_portal')
  .set({ f_sort_code: 2 }).where('f_id', '=', id).executeTakeFirst()
result.numUpdatedRows // → 1n

// 构造器覆盖不到的形态（相关子查询等）走 sql 模板——值仍参数绑定，语句仍过数据库门面
const latest = await sql<{ f_id: string, last_release_at: string | null }>`
  select p.f_id,
         (select max(d.f_last_modify_time) from demo_portal_data d
           where d.f_portal_id = p.f_id and d.f_type = 'RELEASE') as last_release_at
    from demo_portal p
    where p.f_tenant_id = ${tenantId} and p.f_enabled_mark = 1
`.execute(ky)
```

Runtime-dynamic tables/columns (visualdev-style) use the re-exported `dynamic` module. Transactions rebind Kysely onto the transaction connection with `kyselyFor(database, conn)` — see [Multi-datasource → Transactions](#transactions). Dialect-level imports (compilers, drivers) live on the `@ling2/ling-rdb/orm` subpath.

## Tenant line

Row-level tenant filtering — the Service-Definition counterpart of Ling's `BasicTenantInnerInterceptor` / `BasicTenantHandler`. **Design baseline: business SQL carries zero tenant predicates.** The request scope rides on `AsyncLocalStorage`; a wrapped database facade compiles the missing tenant predicates in at execution time.

### 配置方式（Configuration）

One rule = tenant column + controlled-table list. Tables whose tenant column is non-standard get their **own rule with its own column name**; wrap with one or many rules:

```ts
import { wrapTenantLineDatabase, type TenantLineRule } from '@ling2/ling-rdb'

// 标准列受控表一条规则
const stdRule: TenantLineRule = { column: 'f_tenant_id', tables: ['teacher', 'student'] }
// 非标准租户列的特殊表独立配置（列名自持）
const relRule: TenantLineRule = { column: 'tenant_code', tables: ['teacher_student'] }
// 非受控表（如 classroom）不进任何清单 → 永不注入
const tenantDb = wrapTenantLineDatabase(db, [stdRule, relRule])
```

### 使用方式（Usage）

```ts
import { runWithTenantLine } from '@ling2/ling-rdb'

// 业务 SQL 零租户谓词——受控表的谓词由拦截层在执行期编译注入：
await runWithTenantLine({ tenantId: '000000', filter: true }, async () => {
  await tenantDb.query(
    'SELECT t.name, s.name AS student_name FROM teacher t'
    + ' JOIN teacher_student ts ON t.id = ts.teacher_id'
    + ' JOIN student s ON s.id = ts.student_id',
  )
  // → 编译为：… WHERE t.f_tenant_id = ? AND ts.tenant_code = ? AND s.f_tenant_id = ?
  //    参数组尾部追加 ['000000', '000000', '000000']
})
```

Compilation rules:

- A controlled table appearing at top level (FROM/JOIN) without a hand-written tenant predicate gets `<prefix.>column = ?` appended at the WHERE tail (before top-level GROUP/ORDER/LIMIT), with the session tenant appended to the parameter list.
- Non-controlled tables are never touched; in multi-table JOINs the primary table is name-qualified even without an alias (no ambiguous columns).
- Legacy compatibility: statements that DO hand-write a controlled table's predicate keep the value-rewrite path (no double predicate).
- Superadmin bypass (`adminBypass`): injection simply does not happen — cross-partition by design; `ignoreTenantLine` = `@TenantIgnore` opt-out.
- INSERT auto-adds the tenant column (appended to the column list + one bound placeholder per VALUES group); when the column is already present it falls back to slot value-rewrite.
- **Fail loud**: a controlled table mentioned where injection cannot guarantee filtering (subqueries / CTEs / derived tables / MySQL multi-table JOIN UPDATE) throws — it never silently skips (that would be a tenant leak). Exits: rewrite as a top-level JOIN/WHERE form, or carry the tenant explicitly inside `ignoreTenantLine`.

### SQL-injection defenses

- **Tenant values stay parameterized end to end**: injected predicates are always `column = ?` + a bound parameter — even a payload like `'; DROP TABLE users; --` as the session tenant lands in params, never in SQL text (pinned per path).
- **Lexical masking**: single-quoted literals (incl. `''` escapes), line comments (`--` to EOL) and block comments (`/* */`) are masked before scanning — semicolons inside strings don't trigger the multi-statement guard; fake predicates/placeholders inside comments are excluded from locating and rewriting (execution ordinals skip them).
- **Multi-statement fail loud**: a top-level semicolon throws (one call, one statement).
- **UNION guard**: a second UNION segment touching a controlled table throws (that segment can't be filtered); non-controlled second segments pass with only the first segment injected.
- **Rule identifier validation**: columns/tables accept identifier shapes (one dot qualifier allowed); hostile configs throw at wrap time; left word boundaries keep a `tenant_id` rule from biting `f_tenant_id` and a `users` rule from touching `users_archive`.
- All defenses pinned in `tests/tenant-line-sqli.spec.ts` (16 cases).

### Unsupported shapes (fail loud — throws, never silently skipped = never a tenant leak)

| Shape | Example | Why it throws |
|---|---|---|
| Subquery touching a controlled table | `SELECT * FROM products WHERE price > (SELECT AVG(price) FROM products)` | depth>0 occurrences can't be guaranteed filtered |
| EXISTS / NOT EXISTS subquery | `SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE …)` | same (inner orders unfiltered) |
| Correlated subquery | `SELECT o.* FROM orders o WHERE o.created_at = (SELECT MAX(o2.created_at) FROM orders o2 WHERE …)` | same |
| CTE (WITH) | `WITH t AS (SELECT … FROM orders o) SELECT * FROM t WHERE …` | inner SELECT can't be injected |
| Derived table | `… FROM (SELECT … FROM orders …) t` | inner SELECT can't be injected |
| INSERT…SELECT | `INSERT INTO users(…) SELECT … FROM orders` | column-slot mapping and SELECT injection are mutually exclusive |
| MySQL multi-table JOIN UPDATE | `UPDATE teacher t JOIN teacher_student ts ON … SET …` | outside the statement family, top-level parse fails |
| Multi-statement text | `SELECT 1; DROP TABLE users` | one call, one statement (top-level semicolon throws) |

Exits: rewrite as a top-level JOIN/WHERE form, or carry the tenant explicitly inside `ignoreTenantLine`.

### Coverage

The full statement-family matrix (basics / aggregates / joins / subqueries / window functions / CTE / DML / edge cases) plus a multi-rule school-domain suite (teacher / student / teacher-student relation with a non-standard tenant column) is pinned in `tests/tenant-line-matrix.spec.ts` — the README examples above run as code inside the same suite.

## Multi-datasource

**Design: named databases side by side — no runtime "switching".** Every provider row mounts one named database on the hub; consumers declare which names they need and resolve them by name. Cross-database work = resolve both and use each.

### Host wiring (one row per database)

Each provider plugin row defines one data source; the `database` field is the registry name consumers resolve by. Rows mount eagerly (pool bootstrap + connectivity check fail loud) and register as an effect (unregister before disconnect):

```ts
// rows in the host composition (conceptual — one per physical database):
// rdb-postgres + { database: 'sessions', url: 'postgres://…/dsh_sessions' }
// rdb-postgres + { database: 'users',    url: 'postgres://…/dsh_users' }
// rdb-mysql    + { database: 'legacy',   url: 'mysql://…' }
```

Gated dialects (oracle / dm / kingbase) must not mount a row without an instance — eager bootstrap would fail the row at load.

### Consumer wiring (declare, fence, resolve)

```ts
import { rdbDatabaseServiceKey, type RdbDatabase } from '@ling2/ling-rdb'

export class OrderService {
  // 'rdb' = the hub; 'orders' = this service's own provider row
  static inject = ['rdb'] as const
  private database!: RdbDatabase

  async init(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // lifecycle fence: wait until the provider row has registered its database
      void this.ctx.inject([rdbDatabaseServiceKey('orders')], async () => {
        try {
          this.database = this.ctx.rdb.database.get('orders')   // fail loud on unknown names
          resolve()
        } catch (e) { reject(e) }
      })
    })
  }
}
```

Need two databases in one service? Fence and resolve each — `get('orders')` and `get('billing')` stay mounted side by side.

### Transactions

`transaction` binds one transaction-scoped connection to `work`: begin → work → commit; on rejection it rolls back and rethrows (a failing rollback aggregates both errors). Inside `work`, rebind mappers and Kysely to the transaction connection — `mapper.use(conn)` and `kyselyFor(db, conn)` — to mix the mbp and orm layers atomically:

```ts
import { kyselyFor } from '@ling2/ling-rdb'

await this.database.transaction(async conn => {
  const scopedMapper = this.mapper.use(conn)                  // mbp writes on the transaction
  const scopedKysely = kyselyFor(this.database, conn)         // orm reads/writes on the same transaction

  await scopedMapper.insert({ fullName: '张三', enCode: 'zs' })
  await scopedKysely.insertInto('audit_log').values({ f_action: 'create' }).execute()
  // any rejection here → whole transaction rolls back
})
```

`withConnection(work)` acquires a connection without a transaction (multi-statement reads that should share one connection). Rollback semantics note: statements that only make sense inside an existing transaction must go through `transaction` — the bound driver fails loud on transaction primitives used outside it.

## Examples

Every section of this README has a runnable twin under [`examples/`](./examples). Each file is self-contained — no real database needed: statements are captured by an in-memory facade and asserted — and the set doubles as the repo smoke test (`pnpm smoke`, wired into CI):

| Example | Covers |
|---|---|
| [`examples/kit-smoke`](./examples/kit-smoke) | registry, placeholders, upsert, list query, tenant value-rewrite |
| [`examples/migrations`](./examples/migrations) | `migrateRdb` versioned DDL, dialect-group chains, idempotent replay |
| [`examples/mbp-crud`](./examples/mbp-crud) | descriptor, forced-fill stamping, CRUD verbs, wrapper, paged double query, `mapper.use(conn)` |
| [`examples/orm-queries`](./examples/orm-queries) | `kyselyFor` select/join/insert/update/delete, `sql` template, transaction binding |
| [`examples/tenant-line`](./examples/tenant-line) | zero-predicate injection, multi-rule school domain, JOIN, INSERT auto-column, fail loud |
| [`examples/tenant-line-security`](./examples/tenant-line-security) | parameterized hostile values, lexical masking, multi-statement/UNION guards, wrap-time identifier validation |
| [`examples/multi-datasource`](./examples/multi-datasource) | registry, service-key fence, `transaction` rebinding (`mapper.use` + `kyselyFor(db, conn)`), rollback, `withConnection` |
| [`examples/portal-lifecycle`](./examples/portal-lifecycle) | **complete business lifecycle** modeled on the `portal` domain of ling-dsh-admin-pro: migrations → repository → service → create / duplicate-rejected / list / three-state layout data / release snapshot / multi-row guard / logical delete |

Run one example (or all, via the smoke entry):

```sh
node --import tsx/esm examples/portal-lifecycle/boot.mjs
pnpm smoke
```

## Environment variables

Provider integration suites are gated by their connection URL; unset = skip (not fail). Migration suites run DDL/DROP against the target — **dedicated test databases only, never a shared business instance**.

| Variable | Provider | Example |
|---|---|---|
| `DSH_MYSQL_URL` | provider-mysql | `mysql://user:pass@127.0.0.1:3306/ling_rdb_it` |
| `DSH_POSTGRES_URL` | provider-postgres | `postgres://user:pass@127.0.0.1:5432/ling_rdb_it` |
| `DSH_ORACLE_URL` | provider-oracle | `oracle://user:pass@127.0.0.1:1521/XEPDB1` |
| `DSH_DM_URL` | provider-dm (达梦) | `dm://user:pass@127.0.0.1:5236` |
| `DSH_KINGBASE_URL` | provider-kingbase (PG wire) | `postgres://user:pass@127.0.0.1:5436/ling_rdb_it` |

## License

[MIT](./LICENSE)
