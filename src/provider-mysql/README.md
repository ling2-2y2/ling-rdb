# dsh-rdb-mysql

`ctx.rdb` hub 的 MySQL 提供者（mysql2 连接池）。一条 roster 行 = 一个命名数据库；同一源文件挂两行（不同 `database` 名与 `url`）即一 server 双库。池参数、握手重试与事务聚合语义原样提取自 session-persistence-mysql 的 store（那套语义的原始出处）。

## 配置（cordis.yml 里 plugin 的 config）

| 配置 | 默认 | 说明 |
|---|---|---|
| `database`（必填） | — | 注册名，消费者按名解析（如 `sessions` / `users`） |
| `url`（必填） | — | `mysql://user:password@host:port/database`；密码特殊字符需 percent-encode |
| `connectionLimit` | 4 | 连接池大小（1–64） |
| `connectTimeoutMs` | 60000 | 连接超时（1s–600s） |
| （池 charset） | `utf8mb4_general_ci` | 连接排序规则（mysql2 `charset`）。本树所有库均按 general_ci 约定建（租户 `CREATE DATABASE` 语句与带外管理库）；mysql2 自身默认 `utf8mb4_unicode_ci` 会与 general_ci 列混排序报错，故在 `MysqlRdbDatabase` 内统一取默认（`charset` 选项可覆盖） |

## 生命周期

- **eager open（fails loud）**：`apply` 内建池并取首连接验证，连不上/拒库直接拒绝该行启动，不会静默回退。
- **注册可逆**：`ctx.effect` 包裹——卸载时先从注册表除名再关池。
- **握手抗饥饿**：dsh 启动时 tsx 编译 ~136 个插件条目可能拖慢 MySQL 首次握手；仅建池阶段的 `ETIMEDOUT`/`ECONNRESET` 按 1s、5s 两次退避重试，已建立的连接不重试。
- **数据库必须预先建好**：只验连，从不 `CREATE DATABASE`（唯一例外：dsh-admin 租户创库流程，运行期数据而非 bootstrap 配置）。
- **连接 URL 对 host 内部可见**：`MysqlRdbDatabase.url` getter 供同服务器派生（租户创库把库名段换掉）；带凭据，永不跨 RPC 面出 host。

## 依赖安装

本目录不是 pnpm workspace 成员，`mysql2` 装在插件自己的 `node_modules`：

```sh
cd scratch-plugin/bsh-scratch-plugin/dsh-rdb-mysql
pnpm install --ignore-workspace --config.auto-install-peers=false
```

⚠️ 目录移动/换机器后必须重跑（症状：启动报 `Cannot find package 'mysql2' imported from .../database.ts`）。

## 测试

```sh
DSH_MYSQL_URL='mysql://user:pass@127.0.0.1:3306/testdb' npx vitest run
```

覆盖：query/execute 归一化、事务提交/回滚、双 database 名并存、坏 URL 拒绝启动。未设置环境变量时整套跳过。
