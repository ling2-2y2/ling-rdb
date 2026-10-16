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

## mbp 语义层（单表 CRUD）

一个表描述符 + 一个 `BaseMapper` 撑起单表全套生命周期。审计盖戳、逻辑删、租户分区、类型驱动行映射全部由描述符派生——写路径无条件盖戳、调用方无法跳过。以下形态照 `ling-dsh-admin-pro` 的 portal 域仓库。

### 声明表

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

### 构造 mapper（强制填充）

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

请求作用域：`runWithMbpFill({ operatorId, tenantId }, …)` 内所有 mapper 写操作自动盖戳——`insert` 生成 `id + creator 对 + 逻辑删位 + 租户`，`updateById` 追加 `last_modify` 对。调用方无法跳过盖戳；上下文完全缺席时落 `null`（不炸、不猜）：

```ts
import { runWithMbpFill } from '@ling2/ling-rdb'

const created = await runWithMbpFill({ operatorId: 'op-1', tenantId: '000000' }, () =>
  mapper.insert({ fullName: '工作台门户', enCode: 'workbench' }))
// INSERT 列序（全派生）：f_id → 数据列 → 审计四列 → f_delete_mark → f_tenant_id
```

### CRUD 动词

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

### 类型化 Wrapper + 分页双查

```ts
import { mbpWrapper } from '@ling2/ling-rdb'

const conditions = mbpWrapper(PORTAL_TABLE)
  .eq('type', 0)                                  // undefined 自动跳过（「传了才生效」）
  .keyword(['fullName', 'enCode'], keyword)       // (a LIKE ? OR b LIKE ?)
  .rawCmp('f_creator_time', '>=', '2026-01-01')   // 描述符外列逃生口（列名须固定字面量）
  .build()

const page = await mapper.selectPage({ page: 1, pageSize: 20, conditions, order: ['f_sort_code ASC'] })
// COUNT 与 SELECT 共享 WHERE；租户/未删谓词由 mapper 自动前置，参数序 = 谓词出现序
page.total // → 总数
page.items // → 已行映射的记录
```

### 手写 SQL + 行映射

复杂查询与聚合保持手写语句一等公民；驱动行经描述符映射回记录，物理/记录边界单源：

```ts
import { decodeRowWith } from '@ling2/ling-rdb'

const rows = await db.query<Record<string, unknown>>(
  'SELECT * FROM demo_portal WHERE f_en_code = ? AND f_tenant_id = ?', ['workbench', tenantId])
const record = rows[0] === undefined ? undefined : decodeRowWith<PortalRecord>(PORTAL_TABLE, rows[0])
```

事务内用 `mapper.use(conn)` 把 mapper 换绑到事务连接——见[多数据源 → 事务](#事务)。

## orm 语句构造层（复杂查询）

Kysely 0.29.5（exact pin）藏在 `kyselyFor(database)` 之后：方言编译器覆盖 mysql / postgresql / kingbase / oracle / dm，语句仍全部经数据库门面执行（池/事务/租户包装零旁路）。**永不裸引 kysely 包**——`sql` 模板与类型由本包再出口。

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

运行期动态表/列（visualdev 场景）用再出口的 `dynamic` 模块。事务内用 `kyselyFor(database, conn)` 换绑到事务连接——见[多数据源 → 事务](#事务)。方言级进口（编译器/驱动）走 `@ling2/ling-rdb/orm` 子路径。

## 租户拦截（tenant line）

行级租户过滤——Ling `BasicTenantInnerInterceptor`/`BasicTenantHandler` 的 Service-Definition 层对应物。**设计基线：业务 SQL 零租户谓词。**请求作用域走 `AsyncLocalStorage`；包装后的数据库外观在执行期把缺失的租户谓词编译进语句。

### 配置方式

一条规则 = 租户列名 + 受控表清单（`TenantLineRule.tables`）。租户列非标准的特殊表**独立配置一条规则**（列名自持）；包装接受一条或多条规则：

```ts
import { wrapTenantLineDatabase, type TenantLineRule } from '@ling2/ling-rdb'

// 标准列受控表一条规则
const stdRule: TenantLineRule = { column: 'f_tenant_id', tables: ['teacher', 'student'] }
// 非标准租户列的特殊表独立配置（列名自持）
const relRule: TenantLineRule = { column: 'tenant_code', tables: ['teacher_student'] }
// 非受控表（如 classroom）不进任何清单 → 永不注入
const tenantDb = wrapTenantLineDatabase(db, [stdRule, relRule])
```

### 使用方式

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

编译规则：

- 受控表出现在顶层（FROM/JOIN）且语句未手写该表租户谓词 → WHERE 尾自动追加 `<前缀.>列 = ?`（插在顶层 GROUP/ORDER/LIMIT 之前），参数组尾部绑会话租户。
- 非受控表永不注入；多表 JOIN 时主表无别名也用表名限定（杜绝同名列歧义）。
- 存量兼容：语句已手写受控表谓词 → 只换绑定值不重复注入。
- 超管旁路（`adminBypass`）：天然不注入=跨分区读写；`ignoreTenantLine` = `@TenantIgnore` 豁免。
- INSERT 自动补租户列（列清单尾追加 + 每组绑一次会话租户）；已含租户列 → 列位换值。
- **fail loud 防线**：受控表出现在无法保证过滤的形态（子查询/CTE/派生表/MySQL 多表 JOIN UPDATE）→ 直接抛错，绝不静默跳过（静默=租户泄漏）；出口=改写为顶层形态，或在 `ignoreTenantLine` 内显式携带租户值。

### SQL 注入防线

- **租户值全程参数化**：注入的谓词一律 `列 = ?` + 参数尾绑会话租户——租户值即使是 `'; DROP TABLE users; --` 这样的载荷也只进参数、永不进 SQL 文本（三路径各有用例钉死）。
- **词法级掩码**：单引号字面量（含 `''` 逃逸）、行注释（`--` 至行尾）、块注释（`/* */`）三态词法扫描——字符串内的分号/伪注释不触发多语句判定；注释内的伪装谓词/占位符不参与定位与换值（执行序号自动跳过）。
- **多语句 fail loud**：顶层分号直接抛错（一条调用一条语句）。
- **UNION 防线**：UNION 第二段涉受控表 → fail loud（第二段无法保证注入）；非受控表第二段正常放行（仅第一段注入）。
- **规则标识符校验**：列名/表名只认标识符形态（可带一级点限定）；敌意配置（含括号/引号/杂符）在包装期抛错；左词边界保证 `tenant_id` 规则不误咬 `f_tenant_id`、`users` 规则不误伤 `users_archive`。
- 全部防线钉在 `tests/tenant-line-sqli.spec.ts`（16 例）。

### 不支持的形态（fail loud——直接抛错，绝不静默跳过=绝不租户泄漏）

| 形态 | 示例 | 抛错原因 |
|---|---|---|
| 子查询涉受控表 | `SELECT * FROM products WHERE price > (SELECT AVG(price) FROM products)` | 深度>0 区域的受控表无法保证过滤 |
| EXISTS/NOT EXISTS 子查询 | `SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE …)` | 同上（子查询内 orders 未过滤） |
| 相关子查询 | `SELECT o.* FROM orders o WHERE o.created_at = (SELECT MAX(o2.created_at) FROM orders o2 WHERE …)` | 同上 |
| CTE（WITH） | `WITH t AS (SELECT … FROM orders o) SELECT * FROM t WHERE …` | CTE 内层 SELECT 无法注入 |
| 派生表 | `… FROM (SELECT … FROM orders …) t` | 派生表内层无法注入 |
| INSERT…SELECT | `INSERT INTO users(…) SELECT … FROM orders` | 列位映射与 SELECT 注入不可兼得 |
| MySQL 多表 JOIN UPDATE | `UPDATE teacher t JOIN teacher_student ts ON … SET …` | 语句家族外，顶层解析失败 |
| 多语句文本 | `SELECT 1; DROP TABLE users` | 一条调用一条语句（顶层分号抛错） |

出口：改写为顶层 JOIN/WHERE 形态，或在 `ignoreTenantLine` 内显式携带租户值。

### 覆盖面

语句族全矩阵（基础/聚合/JOIN/子查询/窗口/CTE/DML/边界）+ 师生域多规则套件（teacher/student/师生关系表含非标准租户列）钉在 `tests/tenant-line-matrix.spec.ts`——本节示例即同套件里真跑的代码。

## 多数据源

**设计：命名多库并存——没有运行时"切换"动作。**每个 provider 行在 hub 上挂一个命名数据库；消费者声明自己需要哪些名字、按名解析。跨库操作=各自解析、各自使用。

### 宿主装配（一库一行）

每个方言 provider 插件行定义一个数据源；`database` 字段就是消费者解析用的注册名。行启动即 eager 建池验连（连不上整行拒启），注册即 effect（先除名后断连）：

```ts
// 宿主组合里的行（示意——一物理库一行）：
// rdb-postgres + { database: 'sessions', url: 'postgres://…/dsh_sessions' }
// rdb-postgres + { database: 'users',    url: 'postgres://…/dsh_users' }
// rdb-mysql    + { database: 'legacy',   url: 'mysql://…' }
```

门控方言（oracle / dm / kingbase）无实例勿挂行——eager 建池会在装载期让整行报错。

### 消费者接线（声明依赖、栅栏、按名解析）

```ts
import { rdbDatabaseServiceKey, type RdbDatabase } from '@ling2/ling-rdb'

export class OrderService {
  // 'rdb' = hub 本体；'orders' = 本服务自己的 provider 行
  static inject = ['rdb'] as const
  private database!: RdbDatabase

  async init(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // 生命周期栅栏：等 provider 行把库注册完成，防激活竞态
      void this.ctx.inject([rdbDatabaseServiceKey('orders')], async () => {
        try {
          this.database = this.ctx.rdb.database.get('orders')   // 未知名 fail loud
          resolve()
        } catch (e) { reject(e) }
      })
    })
  }
}
```

一个服务要多个库就各自栅栏+各自解析——`get('orders')` 与 `get('billing')` 并存互不干扰。

### 事务

`transaction` 把一条事务级连接绑定给 `work`：begin → work → commit；work 拒绝时回滚并重抛（回滚本身也失败则聚合双错误）。`work` 内把 mapper 与 Kysely **换绑**到事务连接——`mapper.use(conn)` 与 `kyselyFor(db, conn)`——mbp 与 orm 两层即在同一事务内原子混写：

```ts
import { kyselyFor } from '@ling2/ling-rdb'

await this.database.transaction(async conn => {
  const scopedMapper = this.mapper.use(conn)                  // mbp 写走事务连接
  const scopedKysely = kyselyFor(this.database, conn)         // orm 读写走同一事务

  await scopedMapper.insert({ fullName: '张三', enCode: 'zs' })
  await scopedKysely.insertInto('audit_log').values({ f_action: 'create' }).execute()
  // 这里任何拒绝 → 整个事务回滚
})
```

`withConnection(work)` 只借连接不开事务（多条语句共享一条连接的读场景）。边界说明：必须在事务内执行的语句原语（beginTransaction/commit/rollback）请走 `transaction`——绑定驱动在事务外调用会 fail loud。

## 示例（examples）

本 README 每一节在 [`examples/`](./examples) 下都有可跑的孪生件。示例按「**给人读**」写：每一步把生成的 SQL、参数与返回值打印出来（数据库由 [`examples/_lib`](./examples/_lib) 的共用内存假库顶替，无需真实库）；整组兼任仓库冒烟测试（`pnpm smoke`，已接 CI），行为契约由 `tests/` 的 vitest 套件钉守。

| 示例 | 覆盖 |
|---|---|
| [`examples/kit-basics`](./examples/kit-basics) | 注册表、占位符、upsert、列表查询、租户换值 |
| [`examples/migrations`](./examples/migrations) | `migrateRdb` 版本化 DDL、方言分派组、幂等重放 |
| [`examples/mbp-crud`](./examples/mbp-crud) | 描述符、强制填充、CRUD 动词、Wrapper、分页双查、`mapper.use(conn)` |
| [`examples/orm-queries`](./examples/orm-queries) | `kyselyFor` 三表 JOIN/聚合/分页复杂查询、写三通道、`sql` 模板、事务换绑 |
| [`examples/tenant-line`](./examples/tenant-line) | 零谓词注入、师生域多规则、JOIN、INSERT 补列、fail loud |
| [`examples/tenant-line-security`](./examples/tenant-line-security) | 敌意值参数化、词法掩码、多语句/UNION 守卫、标识符包装期校验 |
| [`examples/multi-datasource`](./examples/multi-datasource) | 注册表、服务键栅栏、事务换绑（`mapper.use` + `kyselyFor(db, conn)`）、回滚、`withConnection` |
| [`examples/portal-lifecycle`](./examples/portal-lifecycle) | **完整业务生命周期**（照 ling-dsh-admin-pro portal 域，拆仓储/服务/驱动三文件）：迁移 → 创建/判重拒绝/列表/三态布局数据/发布快照/多行守卫/逻辑删 |

单个示例（或全组冒烟）：

```sh
node --import tsx/esm examples/portal-lifecycle/boot.mjs
pnpm smoke
```

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
