# hub 与方言 kit 基础件

一批纯函数与轻量语义快速过目——都不需要数据库连接。

## 演示内容

- `RdbDatabaseRegistry` 注册表：登记、服务键派生、按名解析（未知名 fail loud）
- `numberedPlaceholders` 占位符翻译：统一 `?` 出口 → PG 的 `$n`
- `upsertSql` 结构化 upsert 渲染（PG `ON CONFLICT` / MySQL `ON DUPLICATE`）
- `buildRdbListQuery` 声明式分页列表查询
- `wrapTenantLineDatabase` + `runWithTenantLine`：手写谓词绑定值的执行期换值

## 跑起来

```sh
node --import tsx/esm examples/kit-basics/boot.mjs
```

对照阅读：README「Registry / dialect kit」相关章节；租户换值的完整注入
形态见 [`../tenant-line`](../tenant-line)。
