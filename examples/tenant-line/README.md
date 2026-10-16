# 注入式租户过滤（tenant line）

业务 SQL 零租户谓词：受控表（规则清单里的表）的租户过滤由拦截层在执行期
编译注入——读补 WHERE、INSERT 补列、JOIN 按别名归属判定。

## 演示内容

- 零谓词注入：单表 WHERE 尾自动补 + 参数尾绑会话租户
- 多规则：标准租户列一条规则、非标准列（`tenant_code`）独立一条
- 多表 JOIN：谓词按归属表（别名）判定
- 非受控表永不注入、参数原样透传
- INSERT 自动补租户列
- 豁免两形态：`filter: false` 管理旁路 / `ignoreTenantLine` 作用域
- fail loud：子查询 / CTE / 多语句直接抛错，绝不静默跳过（绝不租户泄漏）

## 跑起来

```sh
node --import tsx/esm examples/tenant-line/boot.mjs
```

无需真实数据库：注入后的语句由 [`examples/_lib`](../_lib/fake-db.mjs) 假库
捕获并打印，前后对比一眼可见。

对照阅读：README「Tenant line」一章；安全防线细节见
[`../tenant-line-security`](../tenant-line-security)。
