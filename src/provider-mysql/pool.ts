/**
 * Pool bootstrap helpers: bounded retry for the first connection a pool
 * establishes. Extracted verbatim from the session-persistence-mysql store,
 * which pioneered these semantics.
 * @module dsh-rdb-mysql/src/pool
 */

import type { Pool, PoolConnection } from 'mysql2/promise'

/**
 * Handshake failures a bounded retry can survive: harness boot compiles many
 * plugin entries while the first pool connection is established, and that
 * load can starve the handshake past the server's `connect_timeout` window
 * (which no client option can raise) long after the TCP connect succeeded.
 */
const TRANSIENT_CONNECT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET'])

/**
 * Pause before each retried handshake attempt, giving a busy boot time to
 * make compile progress; three attempts in total.
 */
const CONNECT_RETRY_DELAYS_MS = [1_000, 5_000] as const

/**
 * Acquire the pool's first connection, retrying transient handshake failures
 * a bounded number of times. The retries only apply while the connection is
 * being established; established connections never retry here.
 * @param pool - pool whose first connection is being acquired.
 * @returns the acquired connection, released by the caller.
 */
export async function connectWithRetry(pool: Pool): Promise<PoolConnection> {
  for (const delayMs of CONNECT_RETRY_DELAYS_MS) {
    try {
      return await pool.getConnection()
    } catch (error: unknown) {
      if (!isTransientConnectError(error)) throw error
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  return pool.getConnection()
}

function isTransientConnectError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && TRANSIENT_CONNECT_CODES.has(String((error as { code?: unknown }).code))
}
