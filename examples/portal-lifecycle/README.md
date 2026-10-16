# 完整业务生命周期（照 portal 域）

照 ling-dsh-admin-pro 的 portal 域形态走通 rdb 全家，三层文件与真实工程
一一对应：

| 文件 | 对应真实工程 | 内容 |
|---|---|---|
| `portal.repository.mjs` | `portal.repository.ts` | 表描述符 + BaseMapper + 手写特型语句（判重/列表/三态数据）+ 行映射 |
| `portal.service.mjs` | `portal.service.ts` | 业务规则编排（判重拒绝、三态语义、发布快照） |
| `boot.mjs` | 启动装配 + 驱动 | 迁移 + 全生命周期演示 |

## 演示内容

- 迁移：两表方言分派组 DDL
- 创建：mbp 强制盖戳（业务 4 个字段 → 全列 INSERT）
- 判重拒绝：业务异常（同时可见租户拦截把占位租户值换成会话租户）
- 列表分页：动态 where + LIMIT/OFFSET + 描述符行映射
- 三态数据（一表三态：MODEL / CUSTOM / RELEASE）：CUSTOM 首存 insert →
  再存 update；发布落 RELEASE 快照
- 三态读多行守卫（`PortalDataDuplicateError`，绝不静默取首行）
- 逻辑删：UPDATE 盖删位，列表随即为空

## 跑起来

```sh
node --import tsx/esm examples/portal-lifecycle/boot.mjs
```

无需真实数据库：语句由 [`examples/_lib`](../_lib/fake-db.mjs) 假库捕获并打印。

对照阅读：README「mbp 语义层」「orm statement layer」「Tenant line」三章 +
bsh 树 `ling-dsh-admin-pro/src/portal/` 源域。
