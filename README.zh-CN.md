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

## 租户拦截（tenant line）

行级租户过滤——Ling `BasicTenantInnerInterceptor`/`BasicTenantHandler` 的 Service-Definition 层对应物。请求作用域走 `AsyncLocalStorage`（`BasicTenantHolder` 线程槽语义）；包装后的数据库外观在执行期把 `列 = ?` 谓词的**绑定值**（及 INSERT 列位）改写为会话租户——SQL 文本归语句方拥有，本层只换值。方言无关：任何 `RdbDatabase` 形状都能包，provider 零参与。

```ts
import {
  ignoreTenantLine,
  runWithTenantLine,
  wrapTenantLineDatabase,
  type TenantLineRule,
} from '@ling2/ling-rdb'

// 规则 = 租户列名 + 受控表清单（Ling tenantTableList / EXCLUDE_TABLES 对应）：
// 清单外表上的谓词一律不动。
const rule: TenantLineRule = { column: 'f_tenant_id', tables: ['base_user', 'base_role'] }
const tenantDb = wrapTenantLineDatabase(db, rule)

// 请求作用域内，经 tenantDb 的每条 query/execute 的租户谓词绑定值
// 自动改写为会话租户：
await runWithTenantLine({ tenantId: '000000', filter: true }, async () => {
  await tenantDb.query('SELECT * FROM base_user WHERE f_tenant_id = ?', ['随便填'])
  // → 绑定值被改写为 '000000'
})

// 超管旁路（BasicTenantInterceptor.doTenantFilter 对应物）：∉ adminTables
// 的受控表谓词被中和为 `1 = 1`（跨分区读写）；adminTables 成员表仍按超管
// 会话租户过滤；INSERT 永不中和（Ling processInsert 纯透传）。
await runWithTenantLine(
  { tenantId: adminSessionTenant, filter: true, adminBypass: { adminTables: new Set() } },
  () => tenantDb.query('SELECT * FROM base_user LIMIT 10'),
)

// @TenantIgnore 对应物：作用域内豁免改写，外层上下文自动恢复。
await ignoreTenantLine(() => provisioningStep())
```

**多表 JOIN 查询支持**：每条 `别名.租户列 = ?` 谓词经 FROM/JOIN 别名表归属到所属表，只有受控表才改写；裸列谓词归属主表（首个 FROM 表）。非受控表的谓词原样透传：

```ts
await runWithTenantLine({ tenantId: '000000', filter: true }, async () => {
  await tenantDb.query(
    'SELECT u.*, d.f_name FROM base_user u JOIN base_dept d' +
    ' ON u.f_dept_id = d.f_id WHERE u.f_tenant_id = ? AND d.f_tenant_id = ? AND f_tenant_id = ?',
    ['raw_u', 'raw_d', 'raw_bare'],
  )
  // → 参数变为 ['000000', 'raw_d', '000000']
  //    base_user（别名 u）两处谓词都改写（别名命中 + 裸列归主表）；
  //    base_dept 不在受控清单 → 谓词原样保留。
})
```

已知边界：语句族解析覆盖 FROM/JOIN 形态上的 `<别名.>列 = ?` 谓词——子查询内嵌谓词不改写（这类语句请放 `ignoreTenantLine` 内显式带租户值）。

写路径：`runWithMbpFill({ tenantId, operatorId }, () => …)` 让作用域内所有 `BaseMapper` 写操作自动盖审计戳（mbp 域）。

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

## 环境变量

provider 集成套件按各自连接 URL 门控；缺省=skip 非失败。迁移套件会对目标库跑 DDL/DROP——**务必专用测试库，绝不指向共享业务实例**。

| 变量 | Provider | 示例 |
|---|---|---|
| `DSH_MYSQL_URL` | provider-mysql | `mysql://user:pass@127.0.0.1:3306/ling_rdb_it` |
| `DSH_POSTGRES_URL` | provider-postgres | `postgres://user:pass@127.0.0.1:5432/ling_rdb_it` |
| `DSH_ORACLE_URL` | provider-oracle | `oracle://user:pass@127.0.0.1:1521/XEPDB1` |
| `DSH_DM_URL` | provider-dm（达梦） | `dm://user:pass@127.0.0.1:5236` |
| `DSH_KINGBASE_URL` | provider-kingbase（PG wire） | `postgres://user:pass@127.0.0.1:5436/ling_rdb_it` |

## 许可

[MIT](./LICENSE)
