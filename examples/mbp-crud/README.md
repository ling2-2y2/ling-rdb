# mbp 单表 CRUD

`BaseMapper` + 一个表描述符撑起单表全套增删改查——业务代码只写业务列，
主键、审计四列、逻辑删位、租户列全部自动盖戳。

## 演示内容

- `defineTable` 描述符：表名 / 主键 / 租户列 / 审计开关 / 逻辑删位 / 列映射
- 强制填充插入（`runWithMbpFill` 作用域盖戳；无上下文落 NULL，不炸不猜）
- 读路径行映射：int / bool / null 类型还原
- `mbpWrapper` 类型化条件 + 分页双查（COUNT + LIMIT/OFFSET，租户/未删谓词自动前置）
- 更新的 SET 白名单（未知字段 fail loud）+ last_modify 盖戳
- `saveOrUpdate` 分流、`existsBy` 判重、`selectByIds` 批量读、`deleteById` 逻辑删
- `mapper.use(conn)` 事务换绑

## 跑起来

```sh
node --import tsx/esm examples/mbp-crud/boot.mjs
```

无需真实数据库：语句由 [`examples/_lib`](../_lib/fake-db.mjs) 假库捕获，
每步打印生成的 SQL、参数与返回值。

对照阅读：README「mbp 语义层」一章。
