/**
 * 达梦传输层翻译纯单测：connectString 归一（强制 autoCommit=false /
 * 参数保留 / 凭据解码）、`?`→`:n`、`[{val}]` 绑定塑形。
 * @module dsh-rdb-dm/tests/translate.spec
 */
import { describe, expect, it } from 'vitest'
import { toDmBinds, toDmConnectString, toDmSql } from '../../src/provider-dm/translate.ts'

describe('toDmConnectString', () => {
  it('dm:// URL 强制补 autoCommit=false', () => {
    expect(toDmConnectString('dm://SYSDBA:p%40ss@192.168.74.129:5236'))
      .toBe('dm://SYSDBA:p@ss@192.168.74.129:5236?autoCommit=false')
  })

  it('已有 autoCommit=true 被改写为 false', () => {
    expect(toDmConnectString('dm://u:p@h:5236?autoCommit=true&schema=S1'))
      .toBe('dm://u:p@h:5236?autoCommit=false&schema=S1')
  })

  it('无 dm:// 前缀的原生串透传并补参', () => {
    expect(toDmConnectString('h:5236')).toBe('h:5236?autoCommit=false')
  })
})

describe('toDmSql / toDmBinds', () => {
  it('? 序号化为 :1/:2（引号感知）', () => {
    expect(toDmSql("select '?' as q from t where c = ? and d = ?"))
      .toBe("select '?' as q from t where c = :1 and d = :2")
  })

  it('参数塑形为 [{val}] 官方绑定形态；空参数为空数组', () => {
    expect(toDmBinds(['a', 1])).toEqual([{ val: 'a' }, { val: 1 }])
    expect(toDmBinds(undefined)).toEqual([])
  })
})
