// No Llame (§8): consulta antes de marcar y bloqueo desde el panel, el vendedor o la tecla del IVR.
import type pg from 'pg';

export type FuenteNoLlame = 'manual' | 'vendedor' | 'ivr';

/** Condición SQL reutilizable: el teléfono `expr` está en el padrón oficial o en la lista propia. */
export function sqlBloqueado(expr: string): string {
  return `(EXISTS (SELECT 1 FROM no_llame_padron p WHERE p.telefono = ${expr})
        OR EXISTS (SELECT 1 FROM no_llame_propia n WHERE n.telefono = ${expr}))`;
}

export async function estaBloqueado(db: pg.Pool | pg.PoolClient, telefono: string): Promise<boolean> {
  const { rows } = await db.query<{ b: boolean }>(`SELECT ${sqlBloqueado('$1')} AS b`, [telefono]);
  return rows[0]?.b ?? false;
}

/** Agrega el número a la lista propia y saca de la cola los leads que todavía no se llamaron. */
export async function bloquearNumero(
  db: pg.Pool | pg.PoolClient,
  b: { telefono: string; fuente: FuenteNoLlame; motivo?: string; usuarioId?: number | null; llamadaId?: number | null },
): Promise<{ nuevo: boolean; leadsRetirados: number }> {
  const { rowCount } = await db.query(
    `INSERT INTO no_llame_propia (telefono, fuente, motivo, usuario_id, llamada_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (telefono) DO NOTHING`,
    [b.telefono, b.fuente, b.motivo ?? null, b.usuarioId ?? null, b.llamadaId ?? null],
  );
  const retirados = await db.query(
    "UPDATE leads SET estado = 'no_llamar' WHERE telefono = $1 AND estado IN ('pendiente', 'reintentar')",
    [b.telefono],
  );
  return { nuevo: rowCount === 1, leadsRetirados: retirados.rowCount ?? 0 };
}
