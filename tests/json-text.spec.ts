/**
 * PG 可存储性净化回归钉（2026-09-24 割接实证）：用户新建对话即报「本轮
 * 运行失败 unsupported Unicode escape sequence」——PG jsonb 逐字解析 JSON
 * 文本，拒收其中的 NUL 转义与孤立代理项转义（MySQL 时代静默放行）；text
 * 列另拒收 NUL 裸字符。钉子覆盖：字符串净化三类替换与有效代理对保真、
 * JSON 列序列化出口零漂移与深净化、PG provider 绑参兜底、mbp json 列编码
 * 出口。纯函数，无服务器。
 * @module dsh-rdb/tests/json-text.spec
 */
import { describe, expect, it } from 'vitest'
import { sanitizeStorableText, stringifyJsonColumn } from '../src/json-text.ts'
import { toPostgresParams } from '../src/provider-postgres/translate.ts'
import { encodeValue } from '../src/mbp/rowmap.ts'
import type { MbpColumnSpec } from '../src/mbp/descriptor.ts'

describe('sanitizeStorableText', () => {
  it('干净字符串原样返回（零拷贝快路径，字节不变）', () => {
    const clean = '普通文本 emoji 👍 ok'
    expect(sanitizeStorableText(clean)).toBe(clean)
  })

  it('NUL 裸字符替换为 U+FFFD（PG text 拒收 0x00）', () => {
    expect(sanitizeStorableText('a\0b')).toBe('a\uFFFDb')
  })

  it('孤立高/低代理项各自替换为 U+FFFD（jsonb 违禁转义根因）', () => {
    expect(sanitizeStorableText('a\uD800b')).toBe('a\uFFFDb')
    expect(sanitizeStorableText('a\uDC00b')).toBe('a\uFFFDb')
  })

  it('有效代理对逐字节保留（emoji 不受净化影响）', () => {
    expect(sanitizeStorableText('a👍b')).toBe('a👍b')
  })

  it('跨字符串拆开的代理对不跨串配对（jsonb 逐串解析，各自替换）', () => {
    expect(sanitizeStorableText('\uD83D')).toBe('\uFFFD')
    expect(sanitizeStorableText('\uDC4D')).toBe('\uFFFD')
  })

  it('末尾悬挂的高代理项也替换', () => {
    expect(sanitizeStorableText('a\uD83D')).toBe('a\uFFFD')
  })
})

describe('stringifyJsonColumn（JSON 列写序列化唯一出口）', () => {
  it('干净值与 JSON.stringify 字节一致（零漂移黄金钉）', () => {
    const value = { a: 1, b: ['文本', { c: null, d: true }], e: '👍' }
    expect(stringifyJsonColumn(value)).toBe(JSON.stringify(value))
  })

  it('NUL 经 stringify 不再产生违禁转义（unsupported Unicode escape 根因）', () => {
    const out = stringifyJsonColumn({ text: 'x\0y' })
    expect(out).not.toContain('\\u0000')
    expect(JSON.parse(out)).toEqual({ text: 'x\uFFFDy' })
  })

  it('孤立代理项经 stringify 不再产生孤立转义', () => {
    const out = stringifyJsonColumn({ text: 'bad\uD83Dpoint' })
    expect(out).not.toMatch(/\\ud83d/i)
    expect(JSON.parse(out)).toEqual({ text: 'bad\uFFFDpoint' })
  })

  it('嵌套数组与对象深净化', () => {
    const out = stringifyJsonColumn({ list: [{ deep: ['\0'] }] })
    expect(JSON.parse(out)).toEqual({ list: [{ deep: ['\uFFFD'] }] })
  })
})

describe('toPostgresParams（PG provider 绑参兜底）', () => {
  it('undefined 透传、非字符串参数不动', () => {
    expect(toPostgresParams(undefined)).toBeUndefined()
    expect(toPostgresParams([1, null, true])).toEqual([1, null, true])
  })

  it('字符串参数净化 NUL 与孤立代理项（text 列 0x00 兜底）', () => {
    expect(toPostgresParams(['a\0b', 'ok\uD800'])).toEqual(['a\uFFFDb', 'ok\uFFFD'])
  })
})

describe('encodeValue（mbp json 列编码出口）', () => {
  const jsonSpec = { type: 'json' } as MbpColumnSpec

  it('脏 JSON 值净化后输出、干净值零漂移', () => {
    expect(encodeValue(jsonSpec, { text: 'x\0y\uD800' })).toBe(JSON.stringify({ text: 'x\uFFFDy\uFFFD' }))
    expect(encodeValue(jsonSpec, { text: '👍' })).toBe(JSON.stringify({ text: '👍' }))
  })

  it('null/undefined 语义维持', () => {
    expect(encodeValue(jsonSpec, null)).toBeNull()
    expect(encodeValue(jsonSpec, undefined)).toBeNull()
  })
})
