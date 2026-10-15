# dsh-rdb-oracle — Oracle provider（dsh-rdb hub）

`oracledb` 7.0.1（thin 模式纯 JS，**要求 Oracle ≥12.1**；11g 需 thick + Instant Client）连接池 → `RdbDatabase` 契约。形态镜像 `dsh-rdb-mysql`：一行挂一个命名库，eager 建池验连（fail loud），注册即 effect（先除名后关池）。

## 机制要点

- **占位符**：语句层统一 `?`，传输层翻译为 `:1,:2…`（`src/translate.ts`，复用 `dsh-rdb/src/placeholders`）
- **事务**：隐式开启——每语句 `autoCommit:false`（oracledb 默认 true，必须逐语句关），首语句即开事务，`commit()/rollback()` 收口；`beginTransaction()` 为语义占位
- **行返回**：`OUT_FORMAT_OBJECT`；写路径返回 `{rows: [], rowsAffected}`（dsh-orm 归一化消费）
- **URL**：`oracle://user:pwd@host:port/service` 或原生 connectString 透传
- **类型**：`@types/oracledb` devDep（oracledb 7.0.1 npm 包不带 d.ts）

## PoC 待办（实例到位后，见方案文档 §6.6 决策规则）

- 源 Oracle 版本确认（thin ≥12.1）；标识符大小写折叠实测（Ling `getKey(dbType)` 根因——查 `ALL_TAB_COLUMNS`）
- `DSH_ORACLE_URL=oracle://user:pwd@host:port/service npx vitest run`（五用例门控壳）

## 安装与测试

```sh
cd dsh-rdb-oracle && pnpm install --ignore-workspace --config.auto-install-peers=false
npx vitest run   # translate 纯单测；门控壳缺环境变量自动 skip
```
