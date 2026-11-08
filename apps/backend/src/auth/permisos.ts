// Permiso efectivo = permisos del rol + concedidos al usuario - quitados al usuario.
import type pg from 'pg';

export async function permisosEfectivos(db: pg.Pool, usuarioId: number): Promise<Set<string>> {
  const { rows } = await db.query<{ codigo: string }>(
    `SELECT p.codigo
       FROM usuarios u
       CROSS JOIN permisos p
       LEFT JOIN rol_permisos rp ON rp.rol = u.rol AND rp.permiso = p.codigo
       LEFT JOIN usuario_permisos up ON up.usuario_id = u.id AND up.permiso = p.codigo
      WHERE u.id = $1
        AND COALESCE(up.concedido, rp.permiso IS NOT NULL)`,
    [usuarioId],
  );
  return new Set(rows.map((r) => r.codigo));
}
