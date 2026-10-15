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
