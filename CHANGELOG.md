# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本语义遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.2] - 2026-10-15

### 文档

- README 双语补「租户拦截（tenant line）」节：`wrapTenantLineDatabase` + `runWithTenantLine` 请求作用域改写、超管旁路（`adminBypass` 中和 `1 = 1`）、`@TenantIgnore` 豁免（`ignoreTenantLine`）与 `runWithMbpFill` 写路径盖戳的完整示例。
- `examples/kit-smoke` 增补租户改写往返（受控表绑定值改写 + 豁免作用域不改写）——README 示例=CI 门禁里真跑的代码。

## [1.0.1] - 2026-10-15

### 文档

- README 双语补「环境变量」节：五方言 provider 集成套件门控 URL 示例（`DSH_MYSQL_URL`/`DSH_POSTGRES_URL`/`DSH_ORACLE_URL`/`DSH_DM_URL`/`DSH_KINGBASE_URL`）与专用测试库纪律（迁移套件跑 DDL/DROP）。

## [1.0.0] - 2026-10-15

### 首发内容

- **关系库 hub**：`Rdb` 服务（`ctx.rdb`，`declare module '@ling2/ling-cordis'` 模块增强随包发布）+ `RdbDatabaseRegistry` 命名库注册表（`rdbDatabaseServiceKey` 生命周期键防激活竞态）。
- **迁移链**：`migrateRdb` 版本化 DDL 执行器（版本表自动建、断链即 fail loud、一条 entry 一条 SQL）。
- **mbp 语义层**：`defineTable` 表描述符 + `BaseMapper` 全套单表 CRUD（审计四列盖戳、逻辑删位、类型驱动行映射、分页双查、类型化 Wrapper、租户与填充 ALS 缝）。
- **orm 语句构造层**：Kysely 0.29.5 驱动门面（四方言编译器 mysql/postgresql/oracle/dm + kingbase=postgresql wire、事务门面、流式查询诚实报错）。
- **方言 kit**：编号占位符翻译（`?`→`$n`/`:n`，引号感知）、结构化 upsert/insert-ignore 渲染与 MySQL 文本适配、声明式分页列表查询、租户行拦截谓词、JSON 列编解码。
- **五方言 provider 插件**：mysql/postgres 常驻 + oracle/dm/kingbase 门控壳（实例缺席勿挂行，eager 建池验连 fail loud）。
- **结构**：`src/hub`（注册表+契约+迁移+错误）、`src/kit`（零连接纯函数）、`src/mbp`、`src/orm`、`src/provider-*`。
- **发布形态**：tsdown 打 JS + tsc 直出 d.ts 模块树；kysely exact pin 0.29.5（升级须复跑 orm 黄金断言 `tests/orm/compile.spec.ts`）。
