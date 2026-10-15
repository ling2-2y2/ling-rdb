/**
 * 占位符序号化的黄金断言：Oracle/达梦族（`:1`）与 PostgreSQL/金仓族
 * （`$1`）两种出口、引号感知（字面量与标识符内的 `?` 不翻译）、无占位
 * 符时原引用返回。全部纯函数，无服务器。
 * @module dsh-rdb/tests/placeholders.spec
 */
import { describe, expect, it } from 'vitest'
import { numberedPlaceholders } from '../src/placeholders.ts'

describe('numberedPlaceholders', () => {
  it('Oracle 族把 ? 序号化为 :1/:2/…', () => {
    expect(numberedPlaceholders('SELECT f_id FROM base_role WHERE f_en_code = ? AND f_type = ?', 'oracle'))
      .toBe('SELECT f_id FROM base_role WHERE f_en_code = :1 AND f_type = :2')
  })

  it('PostgreSQL 族把 ? 序号化为 $1/$2/…', () => {
    expect(numberedPlaceholders('SELECT f_id FROM base_role WHERE f_en_code = ? AND f_type = ?', 'postgres'))
      .toBe('SELECT f_id FROM base_role WHERE f_en_code = $1 AND f_type = $2')
  })

  it('单引号字符串字面量内的 ? 是字面字符，不翻译', () => {
    expect(numberedPlaceholders("SELECT 'a?b' AS q FROM t WHERE c = ?", 'postgres'))
      .toBe("SELECT 'a?b' AS q FROM t WHERE c = $1")
  })

  it("'' 转义的引号整段透传", () => {
    expect(numberedPlaceholders("SELECT 'it''s ?' AS q FROM t WHERE c = ? AND d = ?", 'oracle'))
      .toBe("SELECT 'it''s ?' AS q FROM t WHERE c = :1 AND d = :2")
  })

  it('双引号标识符内的 ? 不翻译（达梦/金仓引用标识符形态）', () => {
    expect(numberedPlaceholders('SELECT "col?name" FROM t WHERE c = ?', 'postgres'))
      .toBe('SELECT "col?name" FROM t WHERE c = $1')
  })

  it('-- 行注释整段透传（WeKnora 基线批：迁移文档注释常含 ? 示例占位符）', () => {
    expect(numberedPlaceholders('-- WHERE tenant_id = ? AND x=1\nSELECT ? FROM t', 'postgres'))
      .toBe('-- WHERE tenant_id = ? AND x=1\nSELECT $1 FROM t')
  })

  it('/* 块注释 */ 整段透传（含跨行）', () => {
    expect(numberedPlaceholders('/* a ? b\nc ? d */ SELECT ?', 'oracle'))
      .toBe('/* a ? b\nc ? d */ SELECT :1')
  })

  it('字符串内的 -- 不是注释（引号优先于注释判定）', () => {
    expect(numberedPlaceholders("SELECT 'a--b ?' FROM t WHERE c = ?", 'postgres'))
      .toBe("SELECT 'a--b ?' FROM t WHERE c = $1")
  })

  it('没有占位符时原引用返回', () => {
    const sql = 'SELECT * FROM t'
    expect(numberedPlaceholders(sql, 'oracle')).toBe(sql)
  })

  it('引号未闭合时保守透传到串尾（不产生半翻译）', () => {
    expect(numberedPlaceholders("SELECT 'unterminated ? FROM t", 'oracle'))
      .toBe("SELECT 'unterminated ? FROM t")
  })

  it('长序列编号连续（抽查第 30 个）', () => {
    const marks = Array.from({ length: 30 }, () => '?').join(', ')
    expect(numberedPlaceholders(`INSERT INTO t VALUES (${marks})`, 'oracle'))
      .toContain(':30')
  })
})
