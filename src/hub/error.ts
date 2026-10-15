/**
 * Typed errors of the relational database hub.
 * @module @ling2/ling-rdb/hub/error
 */

/** Machine-readable failure codes of {@link RdbError}. */
export type RdbErrorCode =
  | 'duplicate-database'
  | 'database-not-found'
  | 'invalid-identifier'
  | 'migration-failed'

/** Hub-level failure with a stable code; providers surface driver errors as-is. */
export class RdbError extends Error {
  override readonly name = 'RdbError'
  /** Stable machine-readable code for callers that branch on failures. */
  readonly code: RdbErrorCode

  /**
   * @param code - Failure category.
   * @param message - Human-readable detail, including names involved.
   * @param options - Standard error options; `cause` carries the driver error.
   */
  constructor(code: RdbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
