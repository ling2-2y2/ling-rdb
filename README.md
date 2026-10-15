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

## License

[MIT](./LICENSE)
