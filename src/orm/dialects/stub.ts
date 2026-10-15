/**
 * 未支持能力的 fail-loud 占位（introspection 本轮出范围）。
 * @module dsh-orm/src/dialects/stub
 */
import type { DatabaseIntrospector } from 'kysely'

/**
 * 构造一个调用即抛错的 introspector——元数据内省（表/列发现）不在本轮
 * 范围，误用时明确报错而非静默错查。
 * @param family - 方言族名（错误消息用）。
 * @returns 抛错实现的 DatabaseIntrospector。
 */
export function unsupportedIntrospector(family: string): DatabaseIntrospector {
  const message = `dsh-orm: ${family} 方言暂不支持数据库内省（introspection）——本轮范围是语句构造与执行，表/列元数据发现待后续批次`
  return {
    async getSchemas() {
      throw new Error(message)
    },
    async getTables() {
      throw new Error(message)
    },
  }
}
