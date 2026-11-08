import type pg from 'pg';

/** Ejecuta `fn` dentro de una transacción: COMMIT si termina bien, ROLLBACK si lanza. */
export async function conTransaccion<T>(db: pg.Pool, fn: (cliente: pg.PoolClient) => Promise<T>): Promise<T> {
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
}
