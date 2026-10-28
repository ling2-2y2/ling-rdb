/**
 * Server-backed tests. Set `DSH_MYSQL_URL` (e.g.
 * `mysql://user:pass@127.0.0.1:3306/dsh_sessions`) to run; without it the
 * suite is skipped because no MySQL server ships with the repository. The
 * probe table is dropped before and after each test.
 *
 * @module @ling2/ling-rdb-mysql/tests/mysql
 */

import { Context, type Fiber } from '@ling2/ling-coris'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Rdb from '../../src/index.ts'
import { apply, type Config } from '../../src/provider-mysql/index.ts'

const url = process.env.DSH_MYSQL_URL

describe.skipIf(url === undefined)('provider-mysql (requires DSH_MYSQL_URL)', () => {
  const dbUrl = url as string

  /** Mount the hub plus one provider row; returns the context and the provider fiber. */
  async function mount(database: string): Promise<{ ctx: Context; fiber: Fiber }> {
    const ctx = new Context()
    await ctx.plugin(Rdb)
    const fiber = await ctx.plugin({ name: 'rdb-mysql', inject: ['rdb'], apply },
      { database, url: dbUrl } satisfies Config)
    return { ctx, fiber }
  }

  async function withDatabase<T>(
    work: (db: import('../../src/hub/types.ts').RdbDatabase) => Promise<T>,
  ): Promise<T> {
    const { ctx, fiber } = await mount('probe')
    try {
      return await work(ctx.rdb.database.get('probe'))
    } finally {
      await fiber.dispose()
    }
  }

  beforeEach(async () => {
    await withDatabase(db => db.execute('DROP TABLE IF EXISTS dsh_rdb_mysql_probe'))
  })

  afterEach(async () => {
    await withDatabase(db => db.execute('DROP TABLE IF EXISTS dsh_rdb_mysql_probe'))
  })

  it('queries and executes with normalized write results', async () => {
    await withDatabase(async db => {
      expect(db.dialect).toBe('mysql')
      expect(db.name).toBe('probe')
      await db.query('CREATE TABLE dsh_rdb_mysql_probe (id INT AUTO_INCREMENT PRIMARY KEY, note VARCHAR(64))')
      const inserted = await db.execute(
        'INSERT INTO dsh_rdb_mysql_probe (id, note) VALUES (?, ?)', [1, 'one'])
      expect(inserted.affectedRows).toBe(1)
      expect(inserted.insertId).toBe(1)
      const rows = await db.query<{ id: number; note: string }>(
        'SELECT id, note FROM dsh_rdb_mysql_probe WHERE id = ?', [1])
      expect(rows).toEqual([{ id: 1, note: 'one' }])
    })
  })

  it('commits transaction work that returns normally', async () => {
    await withDatabase(async db => {
      await db.query('CREATE TABLE dsh_rdb_mysql_probe (id INT PRIMARY KEY)')
      await db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_rdb_mysql_probe (id) VALUES (?)', [7])
      })
      const rows = await db.query('SELECT id FROM dsh_rdb_mysql_probe')
      expect(rows).toEqual([{ id: 7 }])
    })
  })

  it('rolls back transaction work that rejects, rethrowing the original error', async () => {
    await withDatabase(async db => {
      await db.query('CREATE TABLE dsh_rdb_mysql_probe (id INT PRIMARY KEY)')
      const failure = db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_rdb_mysql_probe (id) VALUES (?)', [7])
        throw new Error('work rejected')
      })
      await expect(failure).rejects.toThrow('work rejected')
      const rows = await db.query('SELECT id FROM dsh_rdb_mysql_probe')
      expect(rows).toEqual([])
    })
  })

  it('mounts two database names side by side on one hub', async () => {
    const ctx = new Context()
    await ctx.plugin(Rdb)
    const sessions = await ctx.plugin({ name: 'rdb-mysql', inject: ['rdb'], apply },
      { database: 'sessions', url: dbUrl } satisfies Config)
    const users = await ctx.plugin({ name: 'rdb-mysql', inject: ['rdb'], apply },
      { database: 'users', url: dbUrl } satisfies Config)
    try {
      expect(ctx.rdb.database.names().sort()).toEqual(['sessions', 'users'])
      const one = await ctx.rdb.database.get('sessions').query('SELECT 1 AS ok')
      const two = await ctx.rdb.database.get('users').query('SELECT 2 AS ok')
      expect(one).toEqual([{ ok: 1 }])
      expect(two).toEqual([{ ok: 2 }])
    } finally {
      await users.dispose()
      await sessions.dispose()
    }
  })

  it('rejects the plugin row when the server is unreachable (fail loud)', async () => {
    const ctx = new Context()
    await ctx.plugin(Rdb)
    const failure = ctx.plugin(
      { name: 'rdb-mysql', inject: ['rdb'], apply },
      { database: 'broken', url: 'mysql://nobody@127.0.0.1:1/none', connectTimeoutMs: 1_000 } satisfies Config,
    )
    await expect(failure).rejects.toThrow()
    expect(ctx.rdb.database.names()).toEqual([])
  })
})
