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

### 覆盖面

语句族全矩阵（基础/聚合/JOIN/子查询/窗口/CTE/DML/边界）+ 师生域多规则套件（teacher/student/师生关系表含非标准租户列）钉在 `tests/tenant-line-matrix.spec.ts`——本节示例即同套件里真跑的代码。

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
