# AGENTS.md — ling-rdb（关系库栈子仓）

独立子仓（@ling2/ling-rdb）：hub + orm + mbp + 五方言 provider 三段同包。树内消费统一经 `@ling2/ling-rdb` shim 桥（树根 scripts/build/link-alias.mjs 再生）。本仓是 ling-cordis 血统姊妹仓，发布纪律同 ling-cordis（SemVer+CHANGELOG+prepublishOnly 三连）。

## 目录速览

| 目录 | 职责 |
|---|---|
| hub | RdbDatabase 与连接管理（migrateRdb 迁移链入口） |
| mbp | MyBatis-Plus 对应物：表描述符+BaseMapper 撑起单表全套 CRUD（审计四列盖戳/逻辑删/类型行映射/分页双查/Wrapper 条件） |
| orm | Kysely 构造器出口（含 Kysely 类型与 sql 模板再出口） |
| kit | upsert 方言翻译链（八档）等工具件 |
| provider-postgres / provider-mysql / provider-oracle / provider-dm / provider-kingbase | 五方言 provider（PG=当前主力方言） |

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm check:dts` / `pnpm smoke` | 门禁五件（prepublishOnly=typecheck+test+build） |

## 本模块纪律与坑 ⭐

- **驱动依赖只装本仓包根**：`pnpm install --ignore-workspace --config.auto-install-peers=false`；目录移动/换机后必须重跑（症状=Cannot find package 'mysql2'）。消费者插件目录**不装**驱动。
- **kysely exact pin 0.29.5**：升级必须专门批次并复跑 orm 黄金断言（tests/orm/compile.spec.ts 四方言）；消费方禁直接 `import 'kysely'`（解析不到），一律经 `@ling2/ling-rdb/orm` 再出口。
- Kysely 0.29 三陷阱（回归钉在 compile.spec）：①or()/and() 收单数组参数（varargs 编译出恒假）；②事务=db.transaction().execute(cb)（旧回调形态不报错但什么都不执行）；③写结果位=numUpdatedRows/numDeletedRows。
- oracledb 正确包名=`oracledb`（node-oracledb 是同名占位包）。
- 栈内行序：rdb → provider 各行 → 消费者（硬规则 4）；消费方 init 栅栏模板=doc/agents/rdb-and-datalayer.md。
- **子仓推送走发布序**：动本子仓的提交推送一律走 `node scripts/stack-image/dev/deploy-stack-remote.mjs --release` 单命令（GitHub+gitee 双源核对后推 bsh 指针），禁手工分步推。

---

全局规范见树根 [AGENTS.md](../AGENTS.md)；此处只列本模块增量。
