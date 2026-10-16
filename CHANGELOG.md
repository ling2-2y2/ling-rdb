# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本语义遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.4.0] - 2026-10-16

### 新增（orm 公开出口 + examples 全量配套）

- **orm 层公开出口修复**：1.3.0 及之前 `kyselyFor` 在发布物中不可达（tsdown 单入口 + 根出口无 orm + exports 无子路径）——本版三处补齐：①根出口 re-export 高频面（`kyselyFor` / `sql` / `dynamic` 与 `Kysely` / `SelectQueryBuilder` 类型）；②tsdown 双入口（`dist/index.js` + `dist/orm/index.js`）；③exports 增 `./orm` 子路径（方言适配器/驱动类全量面）。
- **examples 扩容**（README 各节的可跑孪生件，自含可跑、语句捕获断言、`pnpm smoke` 总入口接 CI）：`migrations`（版本化 DDL/方言分派组/幂等重放）、`mbp-crud`（描述符/强制填充/CRUD 动词/Wrapper/分页双查/事务换绑）、`orm-queries`（JOIN 分页/三通道写计数/sql 模板/事务绑定）、`tenant-line`（零谓词注入/师生域多规则/JOIN/INSERT 补列/fail loud）、`tenant-line-security`（敌意值参数化/词法掩码/多语句与 UNION 守卫/标识符校验/词边界）、`multi-datasource`（注册表/服务键栅栏/事务换绑混写/回滚/withConnection）、`portal-lifecycle`（**完整业务生命周期**，照 ling-dsh-admin-pro portal 域：迁移→仓储→服务→创建/判重/列表/三态数据/发布快照/多行守卫/逻辑删）。

### 文档

- README 双语补「mbp 语义层」「orm 语句构造层」两章（照 portal.repository.ts 形态：描述符/强制填充/CRUD 动词/Wrapper 分页/手写 SQL 行映射；kyselyFor 读写写计数通道/sql 模板/事务换绑）+「示例」索引节；修正事务示例 `kyselyFor` 签名笔误（`kyselyFor(database, conn)`）。

### 修复

- `pnpm-workspace.yaml` allowBuilds 补 `dmdb`；package.json 移除 pnpm 11 已不读的 `pnpm.onlyBuiltDependencies` 死配置。

## [1.3.0] - 2026-10-16

### 文档

- README 双语补「多数据源」章（配置方式/消费者接线/事务）：宿主一库一行 + `database` 注册名 + eager fail loud；消费者 `static inject` + `rdbDatabaseServiceKey` 生命周期栅栏 + `ctx.rdb.database.get(name)` 按名解析；事务 = `transaction` 连接绑定 + `mapper.use(conn)` / `kyselyFor(db, conn)` 换绑混写（mbp 与 orm 同事务原子）+ 回滚语义 + `withConnection` 边界。示例对齐树内活例（datalayer.repository 事务混写）。

## [1.2.0] - 2026-10-15

### 新增（SQL 注入防线 + 用户令测试矩阵）

- **词法级掩码升级**：maskQuoted 从「单引号字面量」扩为三态词法扫描（字符串含 `''` 逃逸/行注释/块注释）——注释内的伪装谓词与占位符不参与定位与换值（执行序号自动跳过），字符串内的分号不触发多语句判定。
- **多语句 fail loud**：顶层（深度 0）分号直接抛错（一条调用一条语句），换值/中和/注入四入口全覆盖。
- **UNION 防线**：UNION 第二段涉受控表 fail loud；非受控第二段正常放行（仅第一段注入）。
- **规则标识符校验**：列名/表名只认标识符形态（可带一级点限定），敌意配置包装期抛错；三处谓词正则加左词边界（`tenant_id` 规则不误咬 `f_tenant_id`）与元字符转义；表名词边界（`users` 不误伤 `users_archive`）。
- **限定列（一级点限定）支持**：规则列如 `pay.tenant_id` 的归属判定（限定符=列自带前缀≠表别名）。
- **不支持的形态 fail loud 清单**（README 双语）：子查询/EXISTS/相关子查询/CTE/派生表/INSERT…SELECT/多表 JOIN UPDATE/多语句——直接抛错绝不静默跳过。
- **测试**：`tests/tenant-line-sqli.spec.ts` 16 例（参数化三路径/词法掩码四例/多语句三例/UNION 两例/标识符四例）。

## [1.1.0] - 2026-10-15

### 新增（设计基线升级：换值式 → 注入式）

- **注入式租户过滤**（设计基线：业务 SQL 零租户谓词）：受控表在顶层（FROM/JOIN）出现而语句未写该表租户谓词时，执行期自动在 WHERE 尾追加 `<前缀.>列 = ?` 并绑会话租户。括号深度感知扫描——子查询/窗口函数括号区域不误伤；多表 JOIN 主表无别名也用表名限定防歧义。
- **受控清单独立配置**：每条 `TenantLineRule` 自持列名+受控表清单；**非标准租户列的特殊表独立配置**（`{ column: 'tenant_code', tables: [...] }`）；`wrapTenantLineDatabase` 接受规则数组（多规则按链依次生效）。
- **INSERT 自动补租户列**（Ling processInsert 对应物）：列清单尾追加租户列 + 每个 VALUES 组尾追加占位符并绑会话租户；已含租户列 → 列位换值。INSERT 语句形态解析弹性化（表名与括号间空格可有可无、关键词大小写不敏感——修复存量正则要求 `users (` 字面空格的隐形限制）。
- **fail loud 防线**：受控表出现在子查询/CTE/派生表等深度>0 区域、或 MySQL 多表 JOIN UPDATE 等无法保证过滤的形态 → 直接抛错（绝不静默跳过造成租户泄漏）。
- **用户令测试矩阵**：Q001~Q707 八组 SQL 形态（基础/聚合/JOIN/子查询/窗口/CTE/DML/边界）+ 师生域多规则套件（teacher/student/teacher_student 非标准列 + 受控清单变量 + 复杂 UPDATE/DELETE/查询）共 52 例钉入 `tests/tenant-line-matrix.spec.ts`；存量语句（手写谓词）零行为变化（换值路径保留）。

### 文档

- README 双语「租户拦截」节重写：注入式设计基线/受控清单配置方式/非标准列独立配置/使用方式/fail loud 边界全说明。

## [1.0.3] - 2026-10-15

### 文档

- README 双语「租户拦截」节补**多表 JOIN** 说明与示例：`别名.租户列 = ?` 谓词经 FROM/JOIN 别名表归属判定，受控表改写、非受控表透传、裸列归主表；已知边界=子查询内嵌谓词不改写（放 `ignoreTenantLine` 显式带值）。
- `examples/kit-smoke` 增补三谓词 JOIN 改写往返（`['000000','raw_d','000000']` 钉）。

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
