# dsh-orm — Kysely 语句构造层（跑在 dsh-rdb hub 上）

纯库包（无 cordis 行，dsh-common 形态）：把 [Kysely](https://kysely.dev) 作为语句构造层（≈ Ling `mybatis-dynamic-sql` 的对应物，见 `../doc/数据访问层-ORM引入方案.md` §6.5/§6.6），自定义 Driver 让**全部 SQL 经 RdbDatabase 门面执行**——池/事务/debug sink/租户包装零旁路。

## 消费形态

```ts
import { kyselyFor } from '../../dsh-orm/src/index.ts'

const db = kyselyFor<MySchema>(ctx.rdb.database.get('users'))  // 按 dialect 分派
const rows = await db.selectFrom('orm_demo_item').select(['f_id']).where('f_en_code', '=', 'demo').execute()
```

参照实现：`../dsh-demo/src/orm/`（服务 + @Remote 面 + 门控测试）。

## 机制清单（机制 → 位置 → 要点）

| 机制 | 位置 | 要点 |
|---|---|---|
| RdbKyselyDriver | `src/driver.ts` | 租约模型：acquire→`withConnection` 占住连接、release 才归还；事务映射 RdbConnection 同名方法；写返回三族形态（OkPacket/rowsAffected/rowCount）归一化 |
| 方言分派 | `src/index.ts` `kyselyFor` | mysql / kingbase / postgresql / oracle / dm；未知方言 fail loud 列支持清单 |
| mysql 方言 | `src/dialects/mysql.ts` | 全复用 Kysely 内置 MysqlAdapter/QueryCompiler/Introspector |
| 金仓/PG 方言 | `src/dialects/kingbase.ts` | PostgresAdapter + 编译器子类：`?` 占位符出口 + 未引用标识符（Ling 全小写表名列名服务端折叠） |
| Oracle/达梦方言 | `src/dialects/oracle.ts` | 编译器子类（`?` + 未引用标识符 + `offset … rows`）+ **limit→fetch 节点插件**（修正基类 limit→offset 发射顺序为 Oracle 族 offset→fetch） |
| 占位符策略 | — | 全族统一出口 `?`（RdbConnection 契约）；`:n`/`$n` 编号翻译归 provider（`dsh-rdb/src/placeholders.ts`） |

## ⚠️ Kysely 0.29 API 陷阱（回归钉子见 tests/compile.spec.ts）

1. `or()/and()` 收**单数组参数**：`eb.or([e1, e2])`——varargs 形态静默编译出 `1 = 0`（恒假）。
2. 事务 API 是 `db.transaction().execute(cb)`（返回 TransactionBuilder），旧回调形态 `db.transaction(cb)` 不报错但**什么都不执行**。
3. 写结果位：UpdateResult.numUpdatedRows / DeleteResult.numDeletedRows / InsertResult.insertId（不是 numAffectedRows）。

## 版本纪律

- `kysely 0.29.5` **exact pin**（0.x semver，minor 可破坏）；升级走专门批次并复跑 `tests/compile.spec.ts` 黄金断言。
- 安装：`cd dsh-orm && pnpm install --ignore-workspace --config.auto-install-peers=false`（kysely 只装在本包 node_modules，dsh-rdb 保持零运行时依赖）。

## 测试

```sh
cd dsh-orm && npx vitest run   # driver 生命周期/归一化 + 四方言编译黄金断言（全离线）
```
