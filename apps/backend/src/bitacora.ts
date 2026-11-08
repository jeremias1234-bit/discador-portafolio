// Bitácora de acciones: quién cambió qué y cuándo.
import type pg from 'pg';

export interface EntradaBitacora {
  usuarioId: number | null;
  accion: string; // ej. 'usuario.crear'
  entidad?: string;
  entidadId?: string | number;
  detalle?: Record<string, unknown>;
  ip?: string;
}

/** Acepta el pool o un cliente dentro de una transacción, para que la entrada quede junto al cambio. */
export async function registrarEnBitacora(
  db: pg.Pool | pg.PoolClient,
  e: EntradaBitacora,
): Promise<void> {
  await db.query(
    `INSERT INTO bitacora (usuario_id, accion, entidad, entidad_id, detalle, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.usuarioId, e.accion, e.entidad ?? null, e.entidadId?.toString() ?? null, e.detalle ?? {}, e.ip ?? null],
  );
}
