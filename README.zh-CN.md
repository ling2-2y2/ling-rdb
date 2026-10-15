# ling-rdb

面向 cordis 系 TypeScript 宿主的**关系数据库 hub**：在 `ctx.rdb` 上挂载一个或多个命名数据库、跑版本化 DDL 迁移，数据访问走两层互补设计——单表 CRUD 用 MyBatis-Plus 风格语义层（`mbp`），复杂查询用 Kysely 语句构造层（`orm`）。内置方言 kit（占位符/upsert 渲染/分页列表/租户谓词）与五方言 provider 插件：mysql、postgres、oracle、dm（达梦）、kingbase（金仓）。

> English documentation see [README.md](./README.md)。

## 特性

- **Hub 不做 IO** —— `ctx.rdb` 是命名库注册表；池与驱动归 provider 行自持，消费者按名解析。
- **迁移链** —— `migrateRdb(db, { table, migrations })`：版本化 DDL 执行器，簿记表自动建；断链即 fail loud（一条 entry 一条 SQL）。
- **mbp 语义层** —— 一个表描述符 + 一个 `BaseMapper` 撑起单表全套 CRUD：审计列自动盖戳、逻辑删位、类型驱动行映射、分页双查、类型化 Wrapper、租户/填充 ALS 缝。
- **orm 语句构造层** —— Kysely 0.29.5（exact pin）驱动门面，方言编译器覆盖 mysql / postgresql / oracle / dm（金仓走 PG wire）；事务门面显式；流式查询诚实报错。
- **方言 kit** —— 编号占位符翻译（`?`→`$n`/`:n`，引号感知）、结构化 upsert / insert-ignore 渲染 + MySQL 文本适配、声明式分页列表、租户行谓词、JSON 列编解码。
- **五方言 provider** —— mysql/postgres 常驻；oracle/dm/kingbase 门控壳（实例缺席勿挂行：eager 建池验连 fail loud）。

## 安装

```sh
npm install @ling2/ling-rdb
# peer: @ling2/ling-cordis ^2.0.0
```

## 快速上手

```ts
import { migrateRdb, defineTable, BaseMapper, numberedPlaceholders, upsertSql } from '@ling2/ling-rdb'

// 迁移链：版本化 DDL，一条 entry 一条语句
await migrateRdb(db, { table: 'demo_kv', migrations: [...] })

// mbp：描述符 → mapper → 类型化 CRUD
const KvMapper = new BaseMapper(defineTable({...}))

// 方言 kit：纯函数零连接
const sql = numberedPlaceholders('INSERT INTO demo_kv VALUES (?, ?)', 'postgres')
```

provider 插件经 cordis 挂载：一行配置 = 一个命名库 + 一条独立连接池（eager fail loud）。

## 结构

```text
src/
├── index.ts        # 聚合根（hub 服务 + 再出口；default = Rdb）
├── hub/            # 注册表、传输契约、迁移执行器、错误类型
├── kit/            # 零依赖方言 kit（占位符/upsert/分页列表/租户/JSON）
├── mbp/            # MyBatis-Plus 风格语义层
├── orm/            # Kysely 语句构造层（方言编译器）
└── provider-*/     # 五方言 provider 插件（mysql/postgres/oracle/dm/kingbase）
```

## 开发

```sh
pnpm install
pnpm typecheck     # tsc --noEmit（strict）
pnpm test          # vitest；provider 集成套件按 DSH_*_URL 门控（无实例=skip 非 fail；务必指向专用测试库）
pnpm build         # tsdown（js）+ tsc d.ts 模块树 -> dist/
pnpm check:dts     # 外部消费者视角 d.ts 冒烟（符号/default/Context.rdb 增强）
pnpm smoke         # 可跑示例：examples/kit-smoke
```

> kysely 是 exact pin（`0.29.5`）：0.x minor 可破坏——任何升级必须复跑 orm 黄金断言（`tests/orm/compile.spec.ts`）。

## 许可

[MIT](./LICENSE)
