/**
 * MetaObjectHandler 等价——强制自动填充的值来源（方案 C / §6.2.2）。
 *
 * 填充本体在 {@link ./mapper.ts BaseMapper} 的语句派生里**无条件发生**
 * （走 mapper 的写路径必填，比 TypeORM Subscriber「QueryBuilder 绕过」
 * 的强制级高）；本模块只回答「值从哪来」：默认走请求作用域 ALS
 * （与 tenant-line 的 `BasicTenantHolder` 同款语义，宿主在面调用处包
 * `runWithMbpFill`），构造 mapper 时也可注入显式来源（测试/无登录链
 * 部署）。两路都缺席时 operator/tenant 落 NULL——不炸、不猜。
 * @module dsh-rdb/src/mbp/fill
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** 一次填充要取的会话值（operator/tenant 同源）。 */
export interface MbpFillValues {
  /** 当前操作人 id；无登录上下文为 null。 */
  readonly operatorId: string | null
  /** 会话租户 id；无租户上下文为 null（无分区表忽略）。 */
  readonly tenantId: string | null
}

/** 填充值来源：返回当前作用域的会话值；无上下文返回 undefined（落 NULL）。 */
export type MbpFillSource = () => MbpFillValues | undefined

const storage = new AsyncLocalStorage<MbpFillValues>()

/**
 * 在一次填充上下文里执行（请求作用域）：`runWithMbpFill({operatorId,
 * tenantId}, () => …)` 内所有 BaseMapper 写操作自动盖戳。
 * @param values - 会话值。
 * @param work - 作用域内执行的工作。
 * @returns work 的结算值。
 */
export function runWithMbpFill<T>(values: MbpFillValues, work: () => Promise<T>): Promise<T> {
  return storage.run(values, work)
}

/** 读取当前填充上下文（ALS 缺席时 undefined）。 */
export function currentMbpFill(): MbpFillValues | undefined {
  return storage.getStore()
}

/** 全 NULL 填充值（无上下文时的落点）。 */
export const NULL_FILL: MbpFillValues = Object.freeze({ operatorId: null, tenantId: null })

/** 默认来源：读 ALS。 */
export function alsFillSource(): MbpFillValues | undefined {
  return currentMbpFill()
}

/**
 * 填充值持有器——「tenant 恒定 + operator 异步解析后刷新」的通用形态
 * （operator 常来自查库解析，无法同步给 fill source；每写操作前调
 * `setOperator` 刷新，mbp 盖戳读最新值）。
 */
export class MbpFillHolder {
  private values: MbpFillValues

  constructor(tenantId: string | null, operatorId: string | null = null) {
    this.values = { tenantId, operatorId }
  }

  /** 直接给 mapper 构造的 source（闭包读最新值）。 */
  readonly source: MbpFillSource = () => this.values

  /** 刷新操作人（operator 解析完成后调用；null = 无操作人）。 */
  setOperator(operatorId: string | null): void {
    this.values = { ...this.values, operatorId }
  }

  /** 当前值快照。 */
  current(): MbpFillValues {
    return this.values
  }
}
