# dsh-rdb ORM 调研结论

2026-08-30 三轮调研的决策记录。对象：`dsh-rdb`（hub）、`dsh-rdb-mysql`（provider）、`dsh-admin`（36 表消费者，src ≈19k 行 / tests ≈7k 行）。问题：是否引入 Sequelize 类 ORM 以改善兼容性、代码量与架构。

## 结论

1. **不引入 Sequelize（或任何全量 ORM）。** 其方言层只翻译自家 finder API 产出的 SQL，不翻译 raw SQL——而这个代码库 100% 的查询都是自己写的：收益上限是 CRUD 切片，代价是 pool/事务/模型所有权与 rdb seam 冲突、Ling 源锚点与三层测试策略（FakeDb 文本匹配 + 门控集成 + 种子逐字节比对）全部作废。
2. **多方言 = 扩 provider 包**（如 `dsh-rdb-oracle`），不是换查询层。Oracle 若成真，Sequelize 无官方方言直接出局（v6/v7 仅 postgres/mysql/mariadb/sqlite/mssql）；唯一稳妥路线是 node-oracledb provider + 消费者侧方言缝。**Phase 2（dsh-rdb-oracle）暂缓**（2026-08-30 决策），按需启动。
3. **查询构建的公共面沉淀在本包 `src/query.ts`**（本次落地）：列清单拼装、固定表模板、IN 片段、声明式分页列表构建器。业务插件禁止重抄这些模板（`.claude/skills/dsh-crud/SKILL.md` 已固化此准则）。

## 决策依据

### Sequelize 为什么出局

- **传输层方言问题已被 seam 隔离**：池/占位符/错误码/insertId 归 provider（`dsh-rdb-mysql` 263 行是模板）；hub 刻意只标准化传输不标准化查询语言（`src/types.ts` 模块注释）。ORM 想同时持有池+事务+模型，无论放哪层都造成第二事实源。
- **Schema 是 Ling 冻结的**：V1 DDL 逐字节锚定 Ling 实体 + H2 转储，V1 之后只增不改；`sync()` 不可用，模型类只是既有表的同义改写。
- **SQL 文本是移植验证载体**：每条语句带 Ling Java 源锚点（含怪癖：enabledMark 12 语义、keyword 触发排序、>1000 id IN 分段）；改写进 finder API = 丢失对照 + 重写 ~7k 行测试。
- **硬查询不可表达**：FOR UPDATE 行锁事务、id-tree LIKE 子树、数据权限 WHERE 片段组合（产物要拼进他人查询）、CREATE DATABASE 租户建库、ON DUPLICATE KEY 种子——全都要 raw，ORM 场景下得到两种风格并存的最差组合。
- **代码量净变化为负**：可覆盖面（列脚手架 + 部分列表构建器 + 行解码）≈ src 的 15–25%，计入门控测试重写后净亏。

### 多方言的正确路线（需求成真时执行）

| 阶段 | 内容 | 量级 |
|---|---|---|
| Phase 0 | hub 契约硬化：provider 归一化 `duplicate-key` 错误；占位符 `?` 保持 hub 线格式、pg provider 负责改写 `$n`；"可移植 SQL 子集"写成评审规则 | ~150–250 行 |
| Phase 1 | 消费者方言缝：8 个非移植点收口为按 `db.dialect` 分发的接口（MERGE upsert / 行锁 / 建库 / 表字段读取 / 各方言 V1 DDL）；分页子句统一走 kit 的单一出口 | ~300–500 行 |
| Phase 2 | 新 provider 包：`dsh-rdb-pg` / `dsh-rdb-sqlite` / `dsh-rdb-oracle`，各自 ~250–400 行，镜像 mysql provider 形态，hub 零改动 | 按需 |

**方言绑定面完整清单**（Phase 0/1 的输入，grep 全量核实）：① 占位符风格（PG 需 `$n`）；② `FOR UPDATE`（仅 codenum 1 处；SQLite 无此语法，靠单写者语义）；③ `ON DUPLICATE KEY UPDATE`（seeds V3 upsert）；④ `CREATE DATABASE ??` + mysql2 专有 `??` 标识符占位符（tenant/provision）；⑤ V1 DDL 的 MySQL 专有语法（ENGINE/CHARSET/列内 COMMENT/LONGTEXT，730 行）；⑥ `ER_DUP_ENTRY` 匹配（codenum 1 处，应归一化到 provider）；⑦ `information_schema.columns WHERE table_schema = DATABASE()`（resource 域，PG 用 current_schema()，SQLite 用 pragma）；⑧ `(? = '' OR f_id <> ?)` 参数类型推断（tenant 域，PG 需实测）。其余 DML 面 ~95% 天然可移植（LIMIT ? OFFSET ? 三家同语法；无外键/无存储过程/应用侧 UUID；`codec.ts` 已容忍三家驱动的 datetime 解码形态）。

### 安全审计结论

- 现行纪律正确：常量 SQL + `?` 值绑定 + 标识符只出自固定白名单（COLUMN_MAP）或正则护栏（`MIGRATION_TABLE_NAME_RE`、`TENANT_EN_CODE_PATTERN`）。
- **ORM 不改善注入面**：raw 路径（`sequelize.query`/`knex.raw`）与手写 SQL 风险等同；ORM 对象查询另有 operator/orderBy 注入的 CVE 类。手写常量 + 白名单的可审计面更小。
- 三个待加固点（与方言无关，遗留待办）：① `dataperm/condition.ts` 把存储 JSON 的 `field`/`tableName` 拼进 SQL 文本——需保存/构建时按标识符白名单校验（Ling 原版同样有此弱点）；② `role/statements.ts` 族 4 处 `LIMIT ${n} OFFSET ${n}` 数字内插——建议统一改绑定（当前上游已数值化，非急）；③ `seeds.ts` V3 权限码常量内插进 SQL 文本——安全仅因编译期常量，需 JSDoc 声明约束。

## 本次落地（2026-08-30）

- **`dsh-rdb/src/query.ts`**（268 行）：`rdbTableColumns`（列序拼装，Ling 约定可覆写）、`rdbTableStatements`（select/selectById/insert/deleteById 四模板）、`inFragment`（空列表 `1 = 0`）、`buildRdbListQuery`（声明式分页列表：eq/keyword/raw/tenant 四种条件、keywordOrder tie-breaker、COUNT 孪生不含分页参数、空 WHERE 省略、`keepEmpty` 复刻 Ling 只判 `!== undefined` 的怪癖）。
- **dsh-admin 十处 statements 接入**（group/action/standing/role/organize/position/resource/menu/tenant/authorize）：脚手架与列表构建器改走 kit，黄金 SQL 与原手写常量逐字节一致；`inFragment` 三处本地定义统一为 kit 再导出。
- 效果：10 个语句文件净 -172 行；kit+测试为一次性成本；新表脚手架从 ~40 行/表降至 ~12 行/表；列序与列表语义从此单一事实源，漂移不可能。
- 验证：`dsh-rdb` 22/22；`dsh-admin` 240/240（含 `DSH_MYSQL_URL` 门控 MySQL 集成全套）。

## 遗留待办

1. 安全加固三项（见上）。
2. Phase 0（hub 错误归一化 + 占位符契约文档）——多方言启动前完成。
3. `user/`、`dataperm/`、`codenum/` 的语句文件仍有本地脚手架，可按同一模式接入 kit（低优先级）。
4. Phase 2 provider（oracle/pg/sqlite）暂缓，需求出现时按本文件路线执行。
