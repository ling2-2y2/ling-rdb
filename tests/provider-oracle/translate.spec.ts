/**
 * Oracle 传输层翻译纯单测：URL 解析（凭据解码/path 保留 service 名）与
 * `?`→`:n` 编号化（引号感知由 dsh-rdb placeholders 套件覆盖）。
 * @module dsh-rdb-oracle/tests/translate.spec
 */
import { describe, expect, it } from 'vitest'
import { parseOracleUrl, toOracleSql } from '../../src/provider-oracle/translate.ts'

describe('parseOracleUrl', () => {
  it('oracle:// URL 拆出凭据与 host:port/service connectString', () => {
    expect(parseOracleUrl('oracle://scott:tiger%40192@192.168.74.129:1521/ORCLPDB1'))
      .toEqual({ user: 'scott', password: 'tiger@192', connectString: '192.168.74.129:1521/ORCLPDB1' })
  })

  it('非 oracle:// 前缀的原生 connectString 原样透传（凭据位为空）', () => {
    expect(parseOracleUrl('db-host:1521/ORCLPDB1'))
      .toEqual({ user: '', password: '', connectString: 'db-host:1521/ORCLPDB1' })
  })

  it('无端口时 connectString 不留空冒号', () => {
    expect(parseOracleUrl('oracle://u:p@host/SVC').connectString).toBe('host/SVC')
  })
})

describe('toOracleSql', () => {
  it('? 序号化为 :1/:2', () => {
    expect(toOracleSql('select f_id from base_role where f_en_code = ? and f_type = ?'))
      .toBe('select f_id from base_role where f_en_code = :1 and f_type = :2')
  })

  it('字面量内的 ? 不翻译', () => {
    expect(toOracleSql("select '?' as q from t where c = ?")).toBe("select '?' as q from t where c = :1")
  })
})
