/**
 * Wrapper——类型化条件构造（方案 C P1，LambdaQueryWrapper 的对应物，
 * `buildRdbListQuery` 声明式条件的链式超集）。字段名在构造期对描述符
 * fail loud 校验后映成物理列名：列名只能来自描述符，永不接收调用方的
 * 列名字符串（防注入的描述符版）。
 *
 * `undefined` 值的条件自动跳过（`eq('enCode', undefined)` = 不加条件），
 * 链式调用可全量罗列无须守卫——对齐 Ling Wrapper 的「传了才生效」语义。
 * @module dsh-rdb/src/mbp/wrapper
 */
import type { MbpTableDescriptor } from './descriptor.ts'
import { columnOf } from './descriptor.ts'
import type { RdbListCondition } from '../query.ts'


/** mbp 旗标列布尔参数归一：JS true/false → 1/0（mbp 列全为数值旗标，
 *  MySQL 驱动静默转换、PG 驱动送 'true' 撞 SMALLINT——波次 5 割接实证）。 */
function normalizeBoolParam<V>(value: V): V | 0 | 1 {
  if (value === true) return 1
  if (value === false) return 0
  return value
}

/** 查询条件构造器（不可变链：每次调用返回新实例）。 */
export class MbpWrapper<T extends object> {
  private readonly parts: readonly RdbListCondition[]

  constructor(
    private readonly descriptor: MbpTableDescriptor,
    parts: readonly RdbListCondition[] = [],
  ) {
    this.parts = [...parts]
  }

  private next(condition: RdbListCondition): MbpWrapper<T> {
    return new MbpWrapper<T>(this.descriptor, [...this.parts, condition])
  }

  /** 等值条件；`value === undefined` 时跳过。 */
  eq<K extends keyof T & string>(field: K, value: T[K] | undefined): MbpWrapper<T> {
    if (value === undefined) return this
    return this.next({ kind: 'eq', column: columnOf(this.descriptor, field), value: normalizeBoolParam(value) })
  }

  /** IN 条件；空数组/undefined 跳过（需要「永不匹配」语义用 raw 自带）。 */
  in<K extends keyof T & string>(field: K, values: readonly T[K][] | undefined): MbpWrapper<T> {
    if (values === undefined || values.length === 0) return this
    const normalized = values.map(v => normalizeBoolParam(v))
    return this.next({ kind: 'raw', sql: `${columnOf(this.descriptor, field)} IN (${normalized.map(() => '?').join(', ')})`, params: normalized })
  }

  /**
   * 比较条件（时间范围/数值阈值等）；`value === undefined` 时跳过。
   * 比较符白名单收死（拼进 SQL 文本的运算符不接受调用方任意串）。
   */
  cmp<K extends keyof T & string>(field: K, op: '>' | '>=' | '<' | '<=', value: T[K] | undefined): MbpWrapper<T> {
    if (value === undefined) return this
    const operators = ['>', '>=', '<', '<='] as const
    if (!operators.includes(op)) {
      throw new Error(`mbp wrapper: 非法比较符 ${JSON.stringify(op)}（白名单：> >= < <=）`)
    }
    return this.next({ kind: 'raw', sql: `${columnOf(this.descriptor, field)} ${op} ?`, params: [value] })
  }

  /**
   * **物理列**比较（描述符外列的逃生口：审计元字段如 `f_creator_time`
   * 不在 columns 里，cmp 够不着）；列名须为调用方固定字面量（同 raw 的
   * 自证纪律），`value === undefined` 跳过，比较符白名单同 {@link cmp}。
   */
  rawCmp(column: string, op: '>' | '>=' | '<' | '<=', value: unknown): MbpWrapper<T> {
    if (value === undefined) return this
    const operators = ['>', '>=', '<', '<='] as const
    if (!operators.includes(op)) {
      throw new Error(`mbp wrapper: 非法比较符 ${JSON.stringify(op)}（白名单：> >= < <=）`)
    }
    return this.next({ kind: 'raw', sql: `${column} ${op} ?`, params: [value] })
  }

  /** 关键词模糊组 `(a LIKE ? OR b LIKE ?)`；空串/undefined 跳过。 */
  keyword(fields: readonly (keyof T & string)[], value: string | undefined): MbpWrapper<T> {
    if (value === undefined || value === '') return this
    return this.next({
      kind: 'keyword',
      columns: fields.map(field => columnOf(this.descriptor, field)),
      value,
    })
  }

  /** 原样条件片段（标识符固定、值走 params——调用方自证，描述符外逃生口）。 */
  raw(sql: string, params?: readonly unknown[]): MbpWrapper<T> {
    return this.next({ kind: 'raw', sql, params })
  }

  /** 产出声明式条件清单（喂给 {@link ./mapper.ts BaseMapper.selectPage}）。 */
  build(): readonly RdbListCondition[] {
    return [...this.parts]
  }
}

/**
 * 从描述符起一个 Wrapper（`mbpWrapper(DESC).eq('enCode', v).keyword([...], kw)`）。
 * @typeParam T - 消费者声明的记录类型。
 * @param descriptor - 表描述符。
 */
export function mbpWrapper<T extends object>(descriptor: MbpTableDescriptor): MbpWrapper<T> {
  return new MbpWrapper<T>(descriptor)
}
