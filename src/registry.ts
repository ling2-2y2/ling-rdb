/**
 * Named database registry of the relational database hub.
 * @module dsh-rdb/src/registry
 */

import type { RdbDatabase } from './types.ts'
import { RdbError } from './error.ts'

/**
 * Mutable name → database table. Multiple databases stay mounted side by
 * side (`sessions`, `users`, …); which database serves which consumer is the
 * consumer's configuration, never a hub-global choice.
 */
export class RdbDatabaseRegistry {
  private readonly databases = new Map<string, RdbDatabase>()

  /**
   * Register a named database. Registration is an effect: the returned
   * disposer removes the name. Disposal does NOT close the database — the
   * owning provider closes it after unregistering.
   * @param name - Registry name, e.g. `sessions` or `users`.
   * @param database - The database facade owned by one provider row.
   * @returns the disposer that unregisters the name.
   */
  register(name: string, database: RdbDatabase): () => void {
    if (this.databases.has(name)) {
      throw new RdbError('duplicate-database', `rdb database '${name}' is already registered`)
    }
    this.databases.set(name, database)
    return () => {
      // Remove only this registration's contribution: after dispose + re-register,
      // a stale disposer firing again must not remove the successor.
      if (this.databases.get(name) === database) {
        this.databases.delete(name)
      }
    }
  }

  /**
   * Resolve a database by name. Unknown names fail loud, listing what is
   * actually mounted, because a silent miss would send a consumer to the
   * wrong database or none at all.
   * @param name - Registered database name.
   * @returns the database facade.
   */
  get(name: string): RdbDatabase {
    const database = this.databases.get(name)
    if (!database) {
      throw new RdbError(
        'database-not-found',
        `rdb database '${name}' is not registered (registered: ${[...this.databases.keys()].join(', ') || 'none'})`,
      )
    }
    return database
  }

  /**
   * Registered database names, for diagnostics.
   * @returns a snapshot array of names.
   */
  names(): string[] {
    return [...this.databases.keys()]
  }
}
