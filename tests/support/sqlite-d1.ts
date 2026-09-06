import { Database } from "bun:sqlite";
import type { D1Transport, D1Statement, D1Result } from "../../src/d1-store";
import { schemaStatements } from "../../src/schema";

/** Local transactional stand-in for Cloudflare D1; never accesses a deployment. */
export class SQLiteD1Transport implements D1Transport {
  constructor(readonly db: Database) { db.exec(`PRAGMA foreign_keys=ON; ${schemaStatements.join(";")}`); }
  async batch(statements: D1Statement[]): Promise<D1Result[]> {
    return this.db.transaction(() => statements.map(({ sql, params = [] }) => {
      const statement = this.db.query(sql);
      if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql)) return { results: statement.all(...params) as Record<string, unknown>[], meta: {} };
      const result = statement.run(...params);
      return { results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
    }))();
  }
}
