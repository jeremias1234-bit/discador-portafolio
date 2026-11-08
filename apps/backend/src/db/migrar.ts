// Aplica en orden los .sql de db/migrations que todavía no se ejecutaron.
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

const DIR_MIGRACIONES = resolve(import.meta.dirname, '../../../../db/migrations');

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migraciones (
      archivo     TEXT PRIMARY KEY,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ archivo: string }>('SELECT archivo FROM schema_migraciones');
  const aplicadas = new Set(rows.map((r) => r.archivo));
  const pendientes = (await readdir(DIR_MIGRACIONES))
    .filter((f) => f.endsWith('.sql') && !aplicadas.has(f))
    .sort();

  if (pendientes.length === 0) console.log('La base ya está al día.');

  for (const archivo of pendientes) {
    const sql = await readFile(join(DIR_MIGRACIONES, archivo), 'utf8');
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(sql);
      await cliente.query('INSERT INTO schema_migraciones (archivo) VALUES ($1)', [archivo]);
      await cliente.query('COMMIT');
      console.log(`Aplicada: ${archivo}`);
    } catch (err) {
      await cliente.query('ROLLBACK');
      throw new Error(`Falló la migración ${archivo}`, { cause: err });
    } finally {
      cliente.release();
    }
  }
} finally {
  await pool.end();
}
