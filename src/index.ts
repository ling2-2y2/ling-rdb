/**
 * Relational database hub (`ctx.rdb`): a named database registry. Providers
 * (e.g. the postgres/mysql provider plugins) mount one {@link RdbDatabase}
 * per row under a registry name; consumers resolve by that name and code
 * against the transport contracts in `hub/types.ts`. The hub performs no IO
 * itself.
 * @module @ling2/ling-rdb
 */

import { Context, Service } from '@ling2/ling-cordis'
import { RdbDatabaseRegistry } from './hub/index.ts'

export * from './hub/index.ts'
export * from './kit/index.ts'
// mbp 语义层（方案 C：描述符 → BaseMapper → 强制填充 → 行映射 → Wrapper）
export {
  BaseMapper,
  MbpFillHolder,
  defineTable,
  columnOf,
  decodeRowWith,
  encodeValue,
  mbpWrapper,
  MbpWrapper,
  patchFromInput,
  randomUuidGenerator,
  runWithMbpFill,
  currentMbpFill,
  toSqlDateTime,
  toIsoDateTime,
} from './mbp/index.ts'
export type {
  IdentifierGenerator,
  MbpColumnType,
  MbpColumnSpec,
  MbpExecutor,
  MbpFillSource,
  MbpFillValues,
  MbpMapperOptions,
  MbpPage,
  MbpPageQuery,
  MbpRow,
  MbpTableDescriptor,
  MbpTableSpec,
} from './mbp/index.ts'

declare module '@ling2/ling-cordis' {
  interface Context {
    rdb: Rdb
  }
}

/**
 * The relational database hub service. Provider rows register databases
 * under `database`; consumers resolve with `ctx.rdb.database.get(name)`.
 */
export class Rdb extends Service {
  /** Named database table; multiple databases stay mounted side by side. */
  readonly database: RdbDatabaseRegistry = new RdbDatabaseRegistry()

  constructor(ctx: Context) {
    super(ctx, 'rdb')
  }
}

// Service packages default-export their service class and nothing else
// plugin-shaped: mixing a default export with a function-plugin `apply`
// makes the Loader drop the plugin namespace.
export default Rdb
