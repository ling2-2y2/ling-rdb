/**
 * mbp 语义层单测（方案 C P0 验收面）：语句派生黄金断言（假执行面捕获
 * SQL/参数）、强制填充回归（审计列必填——mapper 写路径无法跳过盖戳）、
 * 逻辑删/硬删分型、行映射三态转换、分页双查谓词序、Wrapper 类型化构造。
 * @module @ling2/ling-rdb/tests/mbp
 */
import { describe, expect, it } from 'vitest'
import { BaseMapper, MbpFillHolder, decodeRowWith, defineTable, mbpWrapper, patchFromInput, runWithMbpFill } from '../src/mbp/index.ts'
import type { MbpExecutor, MbpTableDescriptor } from '../src/mbp/index.ts'
import { toIsoDateTime, toSqlDateTime } from '../src/mbp/index.ts'
import type { RdbWriteResult } from '../src/hub/types.ts'

/** 捕获型假执行面：记语句与参数，query 回放预置行。 */
class FakeExec implements MbpExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = []
  rows: Record<string, unknown>[] = []
  writeResult: RdbWriteResult = { affectedRows: 1, insertId: 0 }

  async query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
    this.calls.push({ sql, params: params ?? [] })
    return this.rows as readonly T[]
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
    this.calls.push({ sql, params: params ?? [] })
    return this.writeResult
  }
}

/** Ling 风格试点表：id + 六数据列（覆盖全部列类型）+ 审计 + 逻辑删 + 租户。 */
const DEMO = defineTable({
  table: 'base_demo_item',
  id: 'f_id',
  tenant: 'f_tenant_id',
  audit: true,
  deleteMark: 'f_delete_mark',
  columns: {
    fullName: { column: 'f_full_name' },
    enCode: { column: 'f_en_code' },
    sortCode: { column: 'f_sort_code', type: 'int', nullable: true },
    enabledMark: { column: 'f_enabled_mark', type: 'bool', nullable: true },
    config: { column: 'f_config', type: 'json', nullable: true },
    bornAt: { column: 'f_born_at', type: 'datetime', nullable: true },
  },
})

/** 对照组：硬删、无租户、无审计的登记表形态。 */
const REGISTRY = defineTable({
  table: 'base_registry',
  id: 'f_id',
  tenant: null,
  audit: false,
  deleteMark: null,
  columns: { key: { column: 'f_key' } },
})

/** 本地分量构造的定值时钟（断言文本与机器时区无关）。 */
const FIXED_LOCAL = new Date(2026, 8, 5, 12, 0, 0)
const OPERATOR = 'op-1'
const TENANT = '000000'

function makeMapper(descriptor: MbpTableDescriptor, exec: FakeExec): BaseMapper<Record<string, unknown>> {
  return new BaseMapper(descriptor, {
    database: exec,
    fill: () => ({ operatorId: OPERATOR, tenantId: TENANT }),
    idGenerator: () => 'id-fixed',
    now: () => FIXED_LOCAL,
  })
}

describe('defineTable', () => {
  it('rejects illegal table names (injection guard)', () => {
    expect(() => defineTable({ table: 'a; DROP TABLE x', id: 'f_id', tenant: null, audit: false, deleteMark: null, columns: {} }))
      .toThrow(/非法表名/)
  })

  it('rejects duplicate physical columns', () => {
    expect(() => defineTable({
      table: 't', id: 'f_id', tenant: 'f_tenant_id', audit: false, deleteMark: null,
      columns: { a: { column: 'f_tenant_id' } },
    })).toThrow(/重复/)
  })

  it('projection order = id → data → audit → logical-delete → tenant', () => {
    expect(DEMO.projection).toEqual([
      'f_id', 'f_full_name', 'f_en_code', 'f_sort_code', 'f_enabled_mark', 'f_config', 'f_born_at',
      'f_creator_time', 'f_creator_user_id', 'f_last_modify_time', 'f_last_modify_user_id',
      'f_delete_mark', 'f_tenant_id',
    ])
  })
})

describe('BaseMapper.insert', () => {
  it('emits the full derived INSERT with stamps in family column order', async () => {
    const exec = new FakeExec()
    await makeMapper(DEMO, exec).insert({ fullName: '张三', enCode: 'zs', enabledMark: true, config: { a: 1 }, bornAt: FIXED_LOCAL })
    const call = exec.calls[0]!
    expect(call.sql).toBe(
      'INSERT INTO base_demo_item (f_id, f_full_name, f_en_code, f_sort_code, f_enabled_mark, f_config, f_born_at, '
      + 'f_creator_time, f_creator_user_id, f_last_modify_time, f_last_modify_user_id, f_delete_mark, f_tenant_id) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    // 参数序 = 列序：id → 数据（bool true→1、json 串、datetime 本地文本）→ creator 对 → modify 对 NULL → 0 → 租户
    expect(call.params).toEqual([
      'id-fixed', '张三', 'zs', null, 1, '{"a":1}', '2026-09-05 12:00:00',
      '2026-09-05 12:00:00', OPERATOR, null, null, 0, TENANT,
    ])
  })

  it('entity carrying a non-empty id keeps it (MP 语义：generator 只在缺席时生效)', async () => {
    // 消费方 action 域钉子： `update({id:'x'})` 落插分支时
    // 回读必须命中传入 id——saveOrUpdate 的 unknown-id 插入保留调用方 id。
    const exec = new FakeExec()
    const record = await makeMapper(DEMO, exec).insert({ id: 'manual-9', fullName: '带 id' }) as Record<string, unknown>
    expect(exec.calls[0]!.params[0]).toBe('manual-9')
    expect(record.id).toBe('manual-9')
    // 缺席（undefined/空串）仍走 generator
    const auto = await makeMapper(DEMO, exec).insert({ id: '', fullName: '空串' }) as Record<string, unknown>
    expect(auto.id).toBe('id-fixed')
  })

  it('audit columns are MANDATORY on every insert (MetaObjectHandler regression)', async () => {
    // 2026 方案 C 验收钉子：走 mapper 的写路径无法跳过盖戳——即使填充
    // 来源缺席（operator/tenant 落 NULL），审计列与逻辑删位仍然在列。
    const exec = new FakeExec()
    const bare = new BaseMapper(DEMO, { database: exec, idGenerator: () => 'i', now: () => FIXED_LOCAL })
    const record = await bare.insert({ fullName: 'x' }) as Record<string, unknown>
    expect(exec.calls[0]!.sql).toContain('f_creator_time, f_creator_user_id')
    // 尾六参：creatorTime / operator(NULL) / modify 对 NULL / 逻辑删 0 / tenant(NULL)
    expect(exec.calls[0]!.params.slice(-6)).toEqual(['2026-09-05 12:00:00', null, null, null, 0, null])
    expect(record.creatorTime).toBe(FIXED_LOCAL.toISOString())
    expect(record.tenantId).toBeNull()
  })

  it('stamps from the ALS request scope (runWithMbpFill)', async () => {
    const exec = new FakeExec()
    const mapper = new BaseMapper(DEMO, { database: exec, now: () => FIXED_LOCAL })
    const record = await runWithMbpFill({ operatorId: 'als-op', tenantId: 't-als' }, async () =>
      mapper.insert({ fullName: 'y' })) as Record<string, unknown>
    expect(exec.calls[0]!.params[8]).toBe('als-op')
    expect(exec.calls[0]!.params[12]).toBe('t-als')
    expect(record.creatorUserId).toBe('als-op')
  })
})

describe('BaseMapper.updateById / deleteById', () => {
  it('dynamic SET from descriptor whitelist + mandatory last-modify tail', async () => {
    const exec = new FakeExec()
    await makeMapper(DEMO, exec).updateById('id-fixed', { fullName: '李四', sortCode: 3 })
    expect(exec.calls[0]!.sql).toBe(
      'UPDATE base_demo_item SET f_full_name = ?, f_sort_code = ?, f_last_modify_time = ?, f_last_modify_user_id = ? '
      + 'WHERE f_id = ? AND f_tenant_id = ?',
    )
    expect(exec.calls[0]!.params).toEqual(['李四', 3, '2026-09-05 12:00:00', OPERATOR, 'id-fixed', TENANT])
  })

  it('refuses fields outside the descriptor (column whitelist)', async () => {
    const exec = new FakeExec()
    await expect(makeMapper(DEMO, exec).updateById('i', { hacker: 'x' } as never)).rejects.toThrow(/未知字段/)
  })

  it('zero affected rows resolves false (not-found)', async () => {
    const exec = new FakeExec()
    exec.writeResult = { affectedRows: 0, insertId: 0 }
    await expect(makeMapper(DEMO, exec).updateById('i', { fullName: 'x' })).resolves.toBe(false)
  })

  it('logical table deletes via UPDATE SET mark = 1; hard table via DELETE', async () => {
    const logical = new FakeExec()
    await makeMapper(DEMO, logical).deleteById('i')
    expect(logical.calls[0]!.sql).toBe('UPDATE base_demo_item SET f_delete_mark = 1 WHERE f_id = ? AND f_tenant_id = ?')

    const hard = new FakeExec()
    await makeMapper(REGISTRY, hard).deleteById('i')
    expect(hard.calls[0]!.sql).toBe('DELETE FROM base_registry WHERE f_id = ?')
  })
})

describe('BaseMapper.selectById / decode', () => {
  it('logical table adds the NULL-safe not-deleted predicate', async () => {
    const exec = new FakeExec()
    await makeMapper(DEMO, exec).selectById('i')
    expect(exec.calls[0]!.sql).toBe(
      'SELECT f_id, f_full_name, f_en_code, f_sort_code, f_enabled_mark, f_config, f_born_at, '
      + 'f_creator_time, f_creator_user_id, f_last_modify_time, f_last_modify_user_id, f_delete_mark, f_tenant_id '
      + 'FROM base_demo_item WHERE f_id = ? AND f_tenant_id = ? AND (f_delete_mark IS NULL OR f_delete_mark = 0)',
    )
  })

  it('decode maps driver row to the record shape (datetime→ISO, json→object, bool→boolean)', () => {
    const exec = new FakeExec()
    const mapper = makeMapper(DEMO, exec)
    const record = mapper.decode({
      f_id: 'i', f_full_name: '王五', f_en_code: 'ww', f_sort_code: 7, f_enabled_mark: 1,
      f_config: { b: 2 }, f_born_at: FIXED_LOCAL,
      f_creator_time: FIXED_LOCAL, f_creator_user_id: OPERATOR, f_last_modify_time: null, f_last_modify_user_id: null,
      f_delete_mark: 0, f_tenant_id: TENANT,
    }) as Record<string, unknown>
    expect(record.id).toBe('i')
    expect(record.enabledMark).toBe(true)
    expect(record.config).toEqual({ b: 2 })
    expect(record.bornAt).toBe(FIXED_LOCAL.toISOString())
    expect(record.lastModifyTime).toBeNull()
    expect(record.deleteMark).toBe(0)
  })

  it('json columns delivered as text still decode (driver tolerance)', () => {
    const mapper = makeMapper(DEMO, new FakeExec())
    const record = mapper.decode({ f_id: 'i', f_config: '{"c":3}', f_born_at: null }) as Record<string, unknown>
    expect(record.config).toEqual({ c: 3 })
  })

  it('PG jsonb 标量裸串不再炸 parse（tc-1102 原缺陷场景：PG 驱动把 jsonb "auto" 预解成裸串 auto，期望回落原串不抛错）', () => {
    const mapper = makeMapper(DEMO, new FakeExec())
    const record = mapper.decode({ f_id: 'i', f_config: 'auto', f_born_at: null }) as Record<string, unknown>
    expect(record.config).toBe('auto')
  })
})

describe('BaseMapper.selectPage', () => {
  it('auto-prepends tenant + not-deleted before caller conditions (param order mirrors)', async () => {
    const exec = new FakeExec()
    exec.rows = []
    await makeMapper(DEMO, exec).selectPage({
      page: 2, pageSize: 10,
      order: ['f_sort_code'],
      conditions: [{ kind: 'eq', column: 'f_en_code', value: 'zs' }],
    })
    // 家族惯例先 COUNT 后取行
    expect(exec.calls[0]!.sql).toBe(
      'SELECT COUNT(*) AS n FROM base_demo_item WHERE f_tenant_id = ? AND (f_delete_mark IS NULL OR f_delete_mark = 0) AND f_en_code = ?',
    )
    expect(exec.calls[0]!.params).toEqual([TENANT, 'zs'])
    expect(exec.calls[1]!.sql).toBe(
      'SELECT f_id, f_full_name, f_en_code, f_sort_code, f_enabled_mark, f_config, f_born_at, '
      + 'f_creator_time, f_creator_user_id, f_last_modify_time, f_last_modify_user_id, f_delete_mark, f_tenant_id '
      + 'FROM base_demo_item WHERE f_tenant_id = ? AND (f_delete_mark IS NULL OR f_delete_mark = 0) AND f_en_code = ? '
      + 'ORDER BY f_sort_code LIMIT ? OFFSET ?',
    )
    expect(exec.calls[1]!.params).toEqual([TENANT, 'zs', 10, 10])
  })
})

describe('BaseMapper.saveOrUpdate', () => {
  it('with an id: update hit returns the re-read record', async () => {
    const exec = new FakeExec()
    exec.rows = [{ f_id: 'i', f_full_name: '改后', f_born_at: null, f_config: null }]
    const mapper = makeMapper(DEMO, exec)
    const record = await mapper.saveOrUpdate({ id: 'i', fullName: '改后' }) as Record<string, unknown>
    expect(exec.calls[0]!.sql).toContain('UPDATE base_demo_item SET')
    expect(record.fullName).toBe('改后')
  })

  it('with an id that misses: resolves null, NO insert fallback (Ling 分流语义)', async () => {
    const exec = new FakeExec()
    exec.writeResult = { affectedRows: 0, insertId: 0 }
    await expect(makeMapper(DEMO, exec).saveOrUpdate({ id: 'miss', fullName: 'x' })).resolves.toBeNull()
    expect(exec.calls.length).toBe(1) // 只有 UPDATE，无回退 INSERT
  })
})

describe('MbpWrapper', () => {
  it('maps field names to physical columns and skips undefined/empty values', () => {
    const w = mbpWrapper<Record<string, unknown>>(DEMO)
      .eq('enCode', 'zs')
      .eq('sortCode', undefined)
      .in('fullName', ['a', 'b'])
      .keyword(['fullName', 'enCode'], '')
      .keyword(['fullName', 'enCode'], 'kw')
      .build()
    expect(w).toEqual([
      { kind: 'eq', column: 'f_en_code', value: 'zs' },
      { kind: 'raw', sql: 'f_full_name IN (?, ?)', params: ['a', 'b'] },
      { kind: 'keyword', columns: ['f_full_name', 'f_en_code'], value: 'kw' },
    ])
  })

  it('fails loud on unknown fields (descriptor is the only column source)', () => {
    expect(() => mbpWrapper<Record<string, unknown>>(DEMO).eq('nope' as never, 1)).toThrow(/无字段/)
  })
})

describe('datetime conversion kit', () => {
  it('toSqlDateTime: nullish → null; Date → local text; invalid throws', () => {
    expect(toSqlDateTime(null)).toBeNull()
    expect(toSqlDateTime('')).toBeNull()
    expect(toSqlDateTime(FIXED_LOCAL)).toBe('2026-09-05 12:00:00')
    expect(() => toSqlDateTime('not-a-date')).toThrow(/非法时间值/)
  })

  it('toIsoDateTime: Date → ISO; ISO text passthrough; SQL text parsed; empty → null', () => {
    expect(toIsoDateTime(FIXED_LOCAL)).toBe(FIXED_LOCAL.toISOString())
    expect(toIsoDateTime('2026-09-05T04:00:00.000Z')).toBe('2026-09-05T04:00:00.000Z')
    expect(toIsoDateTime('2026-09-05 12:00:00')).toBe(FIXED_LOCAL.toISOString())
    expect(toIsoDateTime('')).toBeNull()
    expect(toIsoDateTime(null)).toBeNull()
  })
})

describe('MbpWrapper.cmp（比较条件，2026-09-05（十二）users 域时间范围迁移所需）', () => {
  it('renders whitelisted comparison operators with bound values; undefined skips', () => {
    const w = mbpWrapper<Record<string, unknown>>(DEMO)
      .cmp('sortCode', '>=', 3)
      .cmp('bornAt', '<=', undefined)
      .cmp('bornAt', '<', '2026-09-05 00:00:00')
      .build()
    expect(w).toEqual([
      { kind: 'raw', sql: 'f_sort_code >= ?', params: [3] },
      { kind: 'raw', sql: 'f_born_at < ?', params: ['2026-09-05 00:00:00'] },
    ])
  })

  it('rejects operators outside the whitelist (no caller-supplied SQL text)', () => {
    expect(() => mbpWrapper<Record<string, unknown>>(DEMO).cmp('sortCode', '=' as never, 1)).toThrow(/非法比较符/)
    expect(() => mbpWrapper<Record<string, unknown>>(DEMO).cmp('sortCode', '; DROP TABLE x' as never, 1)).toThrow(/非法比较符/)
  })
})

describe('通用动词族（2026-09-05（十三）users 抽象所需）', () => {
  it('selectBy renders eq + tenant + notDeleted (+ FOR UPDATE when asked)', async () => {
    const exec = new FakeExec()
    await makeMapper(DEMO, exec).selectBy('enCode', 'zs')
    expect(exec.calls[0]!.sql).toBe(
      'SELECT f_id, f_full_name, f_en_code, f_sort_code, f_enabled_mark, f_config, f_born_at, '
      + 'f_creator_time, f_creator_user_id, f_last_modify_time, f_last_modify_user_id, f_delete_mark, f_tenant_id '
      + 'FROM base_demo_item WHERE f_en_code = ? AND f_tenant_id = ? AND (f_delete_mark IS NULL OR f_delete_mark = 0)',
    )
    expect(exec.calls[0]!.params).toEqual(['zs', TENANT])
    const locked = new FakeExec()
    await makeMapper(DEMO, locked).selectBy('enCode', 'zs', { forUpdate: true })
    expect(locked.calls[0]!.sql).toContain(' FOR UPDATE')
    // 白名单外字段 fail loud
    const bad = new FakeExec()
    await expect(makeMapper(DEMO, bad).selectBy('nope', 1)).rejects.toThrow(/无字段/)
  })

  it('selectById accepts forUpdate; patchFromInput filters + normalizes; decodeRowWith is the shared row mapper', async () => {
    const exec = new FakeExec()
    await makeMapper(DEMO, exec).selectById('i', { forUpdate: true })
    expect(exec.calls[0]!.sql).toMatch(/WHERE f_id = \? AND f_tenant_id = \?.*FOR UPDATE$/)
    const patch = patchFromInput(DEMO, { fullName: '张三', bornAt: '2026-09-05T04:00:00.000Z', hacker: 'x', skipMe: 1 }, ['skipMe'])
    expect(patch).toEqual({ fullName: '张三', bornAt: '2026-09-05T04:00:00.000Z' })
    const row = decodeRowWith(DEMO, { f_id: 'i', f_full_name: '王', f_enabled_mark: 1, f_delete_mark: 0 })
    expect(row).toMatchObject({ id: 'i', fullName: '王', enabledMark: true, deleteMark: 0 })
  })

  it('deleteById enriches logical delete with f_delete_time/f_delete_user_id when the table has them', async () => {
    const exec = new FakeExec()
    await makeMapper(DEMO, exec).deleteById('i', { deleteTime: '2026-09-05 12:00:00', deleteUserId: 'op-9' })
    // DEMO 表无 f_delete_time/f_delete_user_id 列 → 富化位被忽略，只有 mark=1
    expect(exec.calls[0]!.sql).toBe('UPDATE base_demo_item SET f_delete_mark = 1 WHERE f_id = ? AND f_tenant_id = ?')
  })

  it('MbpFillHolder: source 闭包读最新值，setOperator 刷新', async () => {
    const exec = new FakeExec()
    const holder = new MbpFillHolder('t-1', null)
    const mapper = new BaseMapper(DEMO, { database: exec, fill: holder.source, idGenerator: () => 'i', now: () => FIXED_LOCAL })
    await mapper.insert({ fullName: 'a' })
    expect(exec.calls[0]!.params[8]).toBeNull()   // operator NULL
    holder.setOperator('op-2')
    await mapper.insert({ fullName: 'b' })
    expect(exec.calls[0 + 1].params[8]).toBe('op-2') // 刷新后生效
  })
})

describe('Ling BaseService 动词族对齐（2026-09-05（十三））', () => {
  it('selectByIds renders IN + notDeleted + tenant', async () => {
    const exec = new FakeExec()
    exec.rows = []
    await makeMapper(DEMO, exec).selectByIds(['a', 'b'])
    expect(exec.calls[0]!.sql).toContain('WHERE f_id IN (?, ?) AND f_tenant_id = ? AND (f_delete_mark IS NULL OR f_delete_mark = 0)')
    expect(exec.calls[0]!.params).toEqual(['a', 'b', TENANT])
    await expect(makeMapper(DEMO, new FakeExec()).selectByIds([])).resolves.toEqual([])
  })

  it('deleteByIds renders batch logical delete with notDeleted guard', async () => {
    const exec = new FakeExec()
    await makeMapper(DEMO, exec).deleteByIds(['a', 'b'])
    expect(exec.calls[0]!.sql).toBe(
      'UPDATE base_demo_item SET f_delete_mark = 1 WHERE f_id IN (?, ?) AND (f_delete_mark IS NULL OR f_delete_mark = 0) AND f_tenant_id = ?')
    expect(exec.calls[0]!.params).toEqual(['a', 'b', TENANT])
  })

  it('existsBy = isFieldDuplicate：等值判重 + 排除自身 + 未删 + 租户', async () => {
    const exec = new FakeExec()
    exec.rows = [{ n: 1 }]
    await expect(makeMapper(DEMO, exec).existsBy('enCode', 'zs', { excludeId: 'self' })).resolves.toBe(true)
    expect(exec.calls[0]!.sql).toContain('WHERE f_en_code = ? AND f_id <> ? AND f_tenant_id = ? AND (f_delete_mark IS NULL OR f_delete_mark = 0)')
    expect(exec.calls[0]!.params).toEqual(['zs', 'self', TENANT])
    const none = new FakeExec()
    none.rows = [{ n: 0 }]
    await expect(makeMapper(DEMO, none).existsBy('enCode', 'zs')).resolves.toBe(false)
    await expect(makeMapper(DEMO, new FakeExec()).existsBy('nope' as never, 1)).rejects.toThrow(/无字段/)
  })
})
