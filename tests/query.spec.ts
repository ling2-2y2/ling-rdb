/**
 * Golden-text tests of the statement kit: every expected SQL string is
 * copied verbatim from the hand-written dsh-admin statements the kit
 * replaces, proving the builder reproduces them byte-for-byte.
 * @module dsh-rdb/tests/query.spec
 */

import { describe, expect, it } from 'vitest'
import {
  RDB_AUDIT_COLUMNS,
  buildRdbListQuery,
  inFragment,
  rdbTableColumns,
  rdbTableStatements,
} from '../src/query.ts'

describe('rdbTableColumns', () => {
  it('assembles the canonical Ling order (group shape)', () => {
    // GROUP_COLUMNS verbatim (dsh-admin/src/group/statements.ts).
    expect(rdbTableColumns({
      data: ['f_full_name', 'f_en_code', 'f_description', 'f_enabled_mark', 'f_sort_code'],
    })).toEqual([
      'f_id',
      'f_full_name',
      'f_en_code',
      'f_description',
      'f_enabled_mark',
      'f_sort_code',
      'f_creator_time',
      'f_creator_user_id',
      'f_last_modify_time',
      'f_last_modify_user_id',
      'f_tenant_id',
    ])
  })

  it('supports creator-only audit (role insert shape)', () => {
    expect(rdbTableColumns({
      data: ['f_full_name'],
      audit: ['f_creator_time', 'f_creator_user_id'],
    })).toEqual(['f_id', 'f_full_name', 'f_creator_time', 'f_creator_user_id', 'f_tenant_id'])
  })

  it('supports extra columns and omissions (position shape)', () => {
    expect(rdbTableColumns({ data: ['f_full_name'], extra: ['f_delete_mark'] }))
      .toEqual(['f_id', 'f_full_name', ...RDB_AUDIT_COLUMNS, 'f_delete_mark', 'f_tenant_id'])
    expect(rdbTableColumns({ data: ['f_en_code'], audit: [], idColumn: null, tenantColumn: null }))
      .toEqual(['f_en_code'])
  })
})

describe('rdbTableStatements', () => {
  it('renders the four group templates verbatim', () => {
    const columns = rdbTableColumns({
      data: ['f_full_name', 'f_en_code', 'f_description', 'f_enabled_mark', 'f_sort_code'],
    })
    const statements = rdbTableStatements({ table: 'base_group', columns })
    expect(statements.select)
      .toBe('SELECT f_id, f_full_name, f_en_code, f_description, f_enabled_mark, f_sort_code, '
        + 'f_creator_time, f_creator_user_id, f_last_modify_time, f_last_modify_user_id, f_tenant_id FROM base_group')
    expect(statements.selectById)
      .toBe(`${statements.select} WHERE f_id = ? AND f_tenant_id = ?`)
    expect(statements.insert)
      .toBe(`INSERT INTO base_group (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    expect(statements.deleteById).toBe('DELETE FROM base_group WHERE f_id = ? AND f_tenant_id = ?')
  })

  it('renders a diverging insert list and unpartitioned deletes', () => {
    const statements = rdbTableStatements({
      table: 'base_tenant',
      columns: ['f_id', 'f_full_name', 'f_tenant_id'],
      insertColumns: ['f_id', 'f_full_name'],
      tenantColumn: null,
    })
    expect(statements.selectById).toBe(`${statements.select} WHERE f_id = ?`)
    expect(statements.deleteById).toBe('DELETE FROM base_tenant WHERE f_id = ?')
    expect(statements.insert).toBe('INSERT INTO base_tenant (f_id, f_full_name) VALUES (?, ?)')
  })
})

describe('inFragment', () => {
  it('expands one placeholder per value', () => {
    expect(inFragment('f_id', ['a', 'b', 'c'])).toBe('f_id IN (?, ?, ?)')
  })

  it('never matches on an empty list', () => {
    expect(inFragment('f_id', [])).toBe('1 = 0')
  })
})

describe('buildRdbListQuery', () => {
  const groupColumns = [
    'f_id', 'f_full_name', 'f_en_code', 'f_description', 'f_enabled_mark', 'f_sort_code',
    'f_creator_time', 'f_creator_user_id', 'f_last_modify_time', 'f_last_modify_user_id', 'f_tenant_id',
  ]

  it('reproduces the group list rows query (keyword + enabledMark + paging)', () => {
    // buildGroupListQuery rows output verbatim.
    const built = buildRdbListQuery({
      table: 'base_group',
      columns: groupColumns,
      conditions: [
        { kind: 'keyword', columns: ['f_full_name', 'f_en_code', 'f_description'], value: 'dev' },
        { kind: 'eq', column: 'f_enabled_mark', value: 1 },
        { kind: 'tenant', value: '000000' },
      ],
      order: ['f_sort_code ASC', 'f_creator_time ASC'],
      keywordOrder: ['f_last_modify_time DESC'],
      paging: { pageSize: 20, offset: 0 },
    })
    expect(built.sql)
      .toBe(`SELECT ${groupColumns.join(', ')} FROM base_group `
        + 'WHERE (f_full_name LIKE ? OR f_en_code LIKE ? OR f_description LIKE ?) AND f_enabled_mark = ? AND f_tenant_id = ? '
        + 'ORDER BY f_sort_code ASC, f_creator_time ASC, f_last_modify_time DESC LIMIT ? OFFSET ?')
    expect(built.params).toEqual(['%dev%', '%dev%', '%dev%', 1, '000000', 20, 0])
  })

  it('reproduces the group count twin without order or paging params', () => {
    const built = buildRdbListQuery({
      table: 'base_group',
      columns: groupColumns,
      conditions: [
        { kind: 'keyword', columns: ['f_full_name', 'f_en_code', 'f_description'], value: undefined },
        { kind: 'eq', column: 'f_enabled_mark', value: undefined },
        { kind: 'tenant', value: '000000' },
      ],
      order: ['f_sort_code ASC', 'f_creator_time ASC'],
      keywordOrder: ['f_last_modify_time DESC'],
      paging: { pageSize: 20 },
    })
    expect(built.sql)
      .toBe(`SELECT ${groupColumns.join(', ')} FROM base_group WHERE f_tenant_id = ? `
        + 'ORDER BY f_sort_code ASC, f_creator_time ASC LIMIT ? OFFSET ?')
    expect(built.params).toEqual(['000000', 20, 0])
    expect(built.countSql).toBe('SELECT COUNT(*) AS n FROM base_group WHERE f_tenant_id = ?')
    expect(built.countParams).toEqual(['000000'])
  })

  it('reproduces the role list query (leading keyword, keyword-gated order, no paging when all)', () => {
    const roleColumns = [
      'f_id', 'f_full_name', 'f_en_code', 'f_type', 'f_property_json', 'f_global_mark',
      'f_description', 'f_enabled_mark', 'f_sort_code', 'f_is_condition', 'f_condition_json',
      'f_creator_time', 'f_creator_user_id', 'f_last_modify_time', 'f_last_modify_user_id', 'f_tenant_id',
    ]
    const built = buildRdbListQuery({
      table: 'base_role',
      columns: roleColumns,
      conditions: [
        { kind: 'keyword', columns: ['f_full_name', 'f_en_code'], value: 'adm' },
        { kind: 'eq', column: 'f_type', value: undefined },
        { kind: 'eq', column: 'f_enabled_mark', value: 1 },
        { kind: 'tenant', value: '000000' },
      ],
      order: ['f_global_mark ASC', 'f_sort_code ASC', 'f_creator_time ASC'],
      keywordOrder: ['f_last_modify_time DESC'],
    })
    expect(built.sql)
      .toBe(`SELECT ${roleColumns.join(', ')} FROM base_role `
        + 'WHERE (f_full_name LIKE ? OR f_en_code LIKE ?) AND f_enabled_mark = ? AND f_tenant_id = ? '
        + 'ORDER BY f_global_mark ASC, f_sort_code ASC, f_creator_time ASC, f_last_modify_time DESC')
    expect(built.params).toEqual(['%adm%', '%adm%', 1, '000000'])
    expect(built.countSql).toBe(`SELECT COUNT(*) AS n FROM base_role `
      + 'WHERE (f_full_name LIKE ? OR f_en_code LIKE ?) AND f_enabled_mark = ? AND f_tenant_id = ?')
  })

  it('reproduces the button list query (leading equality before keyword)', () => {
    const built = buildRdbListQuery({
      table: 'base_module_button',
      columns: ['f_id', 'f_module_id'],
      conditions: [
        { kind: 'eq', column: 'f_module_id', value: 'm1' },
        { kind: 'keyword', columns: ['f_full_name', 'f_en_code'], value: '' },
        { kind: 'tenant', value: '000000' },
      ],
      order: ['f_sort_code ASC', 'f_creator_time DESC'],
    })
    expect(built.sql)
      .toBe('SELECT f_id, f_module_id FROM base_module_button '
        + 'WHERE f_module_id = ? AND f_tenant_id = ? ORDER BY f_sort_code ASC, f_creator_time DESC')
    expect(built.params).toEqual(['m1', '000000'])
  })

  it('supports keepEmpty keywords, raw conditions, and omitted WHERE (tenant list shape)', () => {
    const unfiltered = buildRdbListQuery({
      table: 'base_tenant',
      columns: ['f_id', 'f_full_name'],
      conditions: [
        { kind: 'keyword', columns: ['f_full_name', 'f_en_code'], value: undefined },
        { kind: 'eq', column: 'f_type', value: undefined },
      ],
      order: ['f_sort_code ASC', 'f_creator_time DESC'],
      tenantColumn: null,
    })
    expect(unfiltered.sql)
      .toBe('SELECT f_id, f_full_name FROM base_tenant ORDER BY f_sort_code ASC, f_creator_time DESC')
    expect(unfiltered.countSql).toBe('SELECT COUNT(*) AS n FROM base_tenant')

    const ranged = buildRdbListQuery({
      table: 'base_tenant',
      columns: ['f_id', 'f_full_name'],
      conditions: [
        { kind: 'keyword', columns: ['f_full_name', 'f_en_code'], value: 'a', keepEmpty: true },
        { kind: 'raw', sql: 'f_creator_time BETWEEN ? AND ?', params: [1, 2] },
      ],
      order: ['f_sort_code ASC', 'f_creator_time DESC'],
      tenantColumn: null,
    })
    expect(ranged.sql)
      .toBe('SELECT f_id, f_full_name FROM base_tenant '
        + 'WHERE (f_full_name LIKE ? OR f_en_code LIKE ?) AND f_creator_time BETWEEN ? AND ? '
        + 'ORDER BY f_sort_code ASC, f_creator_time DESC')
    expect(ranged.params).toEqual(['%a%', '%a%', 1, 2])

    const emptyKept = buildRdbListQuery({
      table: 'base_module',
      columns: ['f_id'],
      conditions: [
        { kind: 'keyword', columns: ['s.f_full_name', 'm.f_full_name', 'm.f_en_code'], value: '', keepEmpty: true },
        { kind: 'tenant', value: '' },
      ],
      order: ['m.f_sort_code ASC', 'm.f_creator_time DESC'],
    })
    expect(emptyKept.sql)
      .toBe('SELECT f_id FROM base_module '
        + 'WHERE (s.f_full_name LIKE ? OR m.f_full_name LIKE ? OR m.f_en_code LIKE ?) AND f_tenant_id = ? '
        + 'ORDER BY m.f_sort_code ASC, m.f_creator_time DESC')
    expect(emptyKept.params).toEqual(['%%', '%%', '%%', ''])
  })

  it('reproduces the organize list query (raw unbound filters, keyword order, gated paging)', () => {
    const built = buildRdbListQuery({
      table: 'base_organize',
      columns: ['f_id', 'f_full_name'],
      conditions: [
        { kind: 'keyword', columns: ['f_full_name', 'f_en_code'], value: 'org' },
        { kind: 'eq', column: 'f_parent_id', value: '-1' },
        { kind: 'raw', sql: 'f_enabled_mark = 1' },
        { kind: 'tenant', value: '000000' },
      ],
      order: ['f_sort_code ASC', 'f_creator_time ASC'],
      keywordOrder: ['f_last_modify_time DESC'],
      paging: { pageSize: 20, offset: 20 },
    })
    expect(built.sql)
      .toBe('SELECT f_id, f_full_name FROM base_organize '
        + 'WHERE (f_full_name LIKE ? OR f_en_code LIKE ?) AND f_parent_id = ? AND f_enabled_mark = 1 AND f_tenant_id = ? '
        + 'ORDER BY f_sort_code ASC, f_creator_time ASC, f_last_modify_time DESC LIMIT ? OFFSET ?')
    expect(built.params).toEqual(['%org%', '%org%', '-1', '000000', 20, 20])
  })

  it('rejects a tenant condition on a tenant-less spec', () => {
    expect(() => buildRdbListQuery({
      table: 'base_tenant',
      columns: ['f_id'],
      conditions: [{ kind: 'tenant', value: 'x' }],
      order: [],
      tenantColumn: null,
    })).toThrow(/tenant condition/)
  })
})
