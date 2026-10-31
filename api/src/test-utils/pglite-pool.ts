import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

/**
 * Minimal pg.Pool stand-in over PGlite (Postgres compiled to WASM), so PgStore SQL
 * runs against a real Postgres engine without a server. One connection: it checks
 * SQL semantics, not concurrency between connections.
 */
export function pglitePool(db = new PGlite()): { db: PGlite; pool: Pool } {
  const query = async (sql: string, params?: unknown[]) => {
    if (!params) {
      const results = await db.exec(sql);
      const last = results[results.length - 1];
      return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 };
    }
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }), end: () => db.close() };
  return { db, pool: pool as unknown as Pool };
}
