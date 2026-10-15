# dsh-rdb-dm — 达梦 DM8 provider（dsh-rdb hub）

达梦官方 npm 驱动 `dmdb`（1.0.52452；官方方言生态只到 typeorm-dm/knex-dm，**无 kysely-dm**——dsh-orm 的 dm 方言在语句层补位）连接池 → `RdbDatabase` 契约。形态镜像 `dsh-rdb-mysql`。

## 机制要点

- **连接串**：`dm://user:pwd@host:port` → 强制补 `autoCommit=false`（事务由门面收口；已有值改写）
- **占位符**：语句层统一 `?`，传输层翻译为 `:1,:2…` + 参数塑形 `[{val: x}, …]`（官方文档位置绑定形态，`src/translate.ts`）
- **事务**：隐式开启（连接串关自动提交）+ `commit()/rollback()` 收口；`beginTransaction()` 为语义占位
- **行返回**：`dmdb.OUT_FORMAT_OBJECT`；写路径 `{rows: [], rowsAffected}`
- **旋钮位**：连接串透传 `compatibleMode`/`columnNameCase`/`schema` 等（DM Node.js 编程指南 10.4 节）

## PoC 待办（实例到位后）

- dmdb 池行为 / `[{val}]` 绑定实测 / 列名大小写折叠（达梦未引用 DDL 折大写）
- `DSH_DM_URL=dm://user:pwd@host:port npx vitest run`（五用例门控壳）

## 安装与测试

```sh
cd dsh-rdb-dm && pnpm install --ignore-workspace --config.auto-install-peers=false
npx vitest run   # translate 纯单测；门控壳缺环境变量自动 skip
```
