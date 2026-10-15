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

Row-level tenant filtering — the Service-Definition counterpart of Ling's `BasicTenantInnerInterceptor` / `BasicTenantHandler`. The request scope rides on `AsyncLocalStorage` (the `BasicTenantHolder` thread-slot semantics); a wrapped database facade rewrites the **bound values** of `column = ?` predicates (and INSERT column positions) to the session tenant at execution time — SQL text stays owned by the statement author. Dialect-free: any `RdbDatabase` shape can be wrapped, providers take no part.

```ts
import {
  ignoreTenantLine,
  runWithTenantLine,
  wrapTenantLineDatabase,
  type TenantLineRule,
} from '@ling2/ling-rdb'

// Rule = tenant column + controlled-table list (Ling tenantTableList / EXCLUDE_TABLES):
// predicates on tables outside the list are left untouched.
const rule: TenantLineRule = { column: 'f_tenant_id', tables: ['base_user', 'base_role'] }
const tenantDb = wrapTenantLineDatabase(db, rule)

// Inside a request scope, every query/execute through tenantDb has its tenant
// predicates' bound values rewritten to the session tenant:
await runWithTenantLine({ tenantId: '000000', filter: true }, async () => {
  await tenantDb.query('SELECT * FROM base_user WHERE f_tenant_id = ?', ['whatever'])
  // → the bound value is rewritten to '000000'
})

// Superadmin bypass (BasicTenantInterceptor.doTenantFilter counterpart):
// predicates on tables ∉ adminTables are neutralized to `1 = 1` (cross-partition
// reads); adminTables members keep filtering with the admin session tenant;
// INSERT is never neutralized (Ling processInsert pass-through).
await runWithTenantLine(
  { tenantId: adminSessionTenant, filter: true, adminBypass: { adminTables: new Set() } },
  () => tenantDb.query('SELECT * FROM base_user LIMIT 10'),
)

// @TenantIgnore counterpart: opt out inside a scoped block, outer scope auto-restored.
await ignoreTenantLine(() => provisioningStep())
```

**Multi-table JOINs are supported**: every `alias.tenant_column = ?` predicate is attributed to its table via the FROM/JOIN alias map, and only controlled tables get rewritten; a bare column predicate belongs to the primary (first FROM) table. Non-controlled tables' predicates pass through untouched:

```ts
await runWithTenantLine({ tenantId: '000000', filter: true }, async () => {
  await tenantDb.query(
    'SELECT u.*, d.f_name FROM base_user u JOIN base_dept d' +
    ' ON u.f_dept_id = d.f_id WHERE u.f_tenant_id = ? AND d.f_tenant_id = ? AND f_tenant_id = ?',
    ['raw_u', 'raw_d', 'raw_bare'],
  )
  // → params: ['000000', 'raw_d', '000000']
  //    base_user (alias u) rewritten ×2 (aliased + bare→primary);
  //    base_dept not in the rule list → its predicate kept as-is.
})
```

Known boundary: the statement-family parser covers `<alias.>column = ?` predicates on FROM/JOIN shapes — subquery-embedded predicates are not rewritten (keep those statements inside `ignoreTenantLine` with explicit tenant values).

Write path: `runWithMbpFill({ tenantId, operatorId }, () => …)` makes every `BaseMapper` write inside the scope auto-stamp the audit columns (`mbp` domain).

## Development

```sh
pnpm install
pnpm typecheck     # tsc --noEmit (strict)
pnpm test          # vitest; provider integration suites gated by DSH_MYSQL_URL / DSH_POSTGRES_URL / DSH_ORACLE_URL / DSH_DM_URL / DSH_KINGBASE_URL (no instance = skip, not fail; always point them at dedicated test databases)
pnpm build         # tsdown (js) + tsc d.ts module tree -> dist/
pnpm check:dts     # external-consumer d.ts smoke (symbols, default export, Context.rdb augmentation)
pnpm smoke         # runnable example: examples/kit-smoke
```

> kysely is an exact pin (`0.29.5`): 0.x minors can break — rerun the orm golden assertions (`tests/orm/compile.spec.ts`) on any upgrade.

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
