/**
 * PG 文本与 JSON 列可存储性净化（2026-09-24 割接实证）：PG 的 text 列拒收
 * U+0000 裸字符（invalid byte sequence），jsonb 列进一步逐字解析 JSON 文本，
 * 拒收其中的 NUL 转义与孤立代理项转义（unsupported Unicode escape
 * sequence）——MySQL 时代这些字符在 JSON 列里被静默接受，切 PG 后含此类
 * 字符的会话事件、消息投影、长期记忆整次写库失败。JSON 列写序列化一律经
 * {@link stringifyJsonColumn}（先深净化再 stringify）；PG provider 绑参层
 * 另用 {@link sanitizeStorableText} 为纯文本参数兜底。两类不可表示字符统一
 * 替换为 U+FFFD（REPLACEMENT CHARACTER），有效代理对（emoji 等）逐字节保留。
 * @module @ling2/ling-rdb/hub/json-text
 */

/** 快速探测：是否含 NUL 或任意 UTF-16 代理项码元（成对与否由净化函数判定）。 */
const UNSTORABLE = /[\0\uD800-\uDFFF]/

/**
 * 把 NUL 与孤立代理项替换为 U+FFFD；成对代理项原样保留。干净字符串原引用
 * 返回（零拷贝快路径，热路径绑参可放心全量过一遍）。
 * @param text - 任意 JS 字符串。
 * @returns 可安全绑定为 PG text、且经 stringify 后不再产生违禁转义的字符串。
 */
export function sanitizeStorableText(text: string): string {
  if (!UNSTORABLE.test(text)) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit === 0) {
      out += '\uFFFD'
      continue
    }
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += text[i] + text[i + 1]
        i++
        continue
      }
      out += '\uFFFD'
      continue
    }
    if (unit >= 0xDC00 && unit <= 0xDFFF) {
      out += '\uFFFD'
      continue
    }
    out += text[i]
  }
  return out
}

/** 值级净化：字符串就地净化、数组与普通对象深遍历；未命中坏字符保持原引用。 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeStorableText(value)
  if (Array.isArray(value)) {
    const out = value.map(sanitizeValue)
    return out.some((item, index) => item !== value[index]) ? out : value
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    let dirty = false
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeValue(item)
      if (out[key] !== item) dirty = true
    }
    return dirty ? out : value
  }
  return value
}

/**
 * JSON 列写序列化唯一出口：先对值做深净化再 stringify。PG jsonb 会解析
 * JSON 文本，字符串值里的 NUL 与孤立代理项经 stringify 变成违禁转义导致
 * 整次写库失败，必须在序列化前替掉。
 * @param value - 记录侧 JSON 值（对象、数组、标量）。
 * @returns JSON 文本（与 `JSON.stringify` 同语义，净化仅作用于字符串值内容）。
 */
export function stringifyJsonColumn(value: unknown): string {
  return JSON.stringify(sanitizeValue(value))
}
