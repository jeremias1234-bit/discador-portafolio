// Alta, edición, baja y permisos de vendedores, supervisores y admins (§2, §14).
//
// Reglas:
//   * Vendedores se gestionan con los permisos 'vendedores.*'; supervisores y admins con 'usuarios.administrar'.
//   * Nadie se da de baja, se borra, se cambia el rol ni se edita los permisos a sí mismo.
//   * Siempre queda al menos un admin activo.
//   * Solo se conceden o quitan permisos que quien edita tiene (sin escalada).
//   * Borrar solo es posible si el usuario nunca tomó una llamada (FK RESTRICT en llamadas).
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { hashearClave } from '../auth/contrasenas.js';
import { registrarEnBitacora } from '../bitacora.js';
import { conTransaccion } from '../db/transaccion.js';
import { publicarEvento } from '../eventos.js';
import { esquemaClave, requierePermiso, usuarioDe, type Rol, type UsuarioSesion } from './autenticacion.js';
import { codigoPg, errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const ROLES = ['vendedor', 'supervisor', 'admin'] as const;
const PRIMER_INTERNO = 1001;

// Lo que se devuelve de un usuario: nunca el hash ni la clave SIP
const COLUMNAS = `id, nombre, usuario, rol, sede_id, interno_sip, tipo_telefono, puede_marcar_manual,
  recibe_ivr, recibe_leads, tope_llamadas::float8 AS tope_llamadas, activo, baja_en, ultimo_acceso, creado_en`;

const esquemaNombreUsuario = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, 'de 3 a 32 caracteres: letras, números, punto o guion');

const camposEditables = {
  nombre: z.string().trim().min(1).max(100),
  usuario: esquemaNombreUsuario,
  rol: z.enum(ROLES),
  sede_id: z.number().int().positive().nullable(),
  tipo_telefono: z.enum(['navegador', 'externo']),
  puede_marcar_manual: z.boolean(),
  recibe_ivr: z.boolean(),
  recibe_leads: z.boolean(), // leads del bot de WhatsApp: turno propio, aparte del IVR
  tope_llamadas: z.number().positive().max(99).nullable(),
};

const esquemaAlta = z
  .object({ ...camposEditables, clave: esquemaClave })
  .partial({ sede_id: true, tipo_telefono: true, puede_marcar_manual: true, recibe_ivr: true, recibe_leads: true, tope_llamadas: true })
  .strict();

const esquemaEdicion = z
  .object(camposEditables)
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'no hay campos para modificar');

const esquemaId = z.object({ id: z.coerce.number().int().positive() });

interface Objetivo {
  id: number;
  rol: Rol;
  activo: boolean;
}

// --- Reglas de permisos ---

function permisoGestion(rol: Rol, accion: 'editar' | 'baja'): string {
  if (rol !== 'vendedor') return 'usuarios.administrar';
  return accion === 'editar' ? 'vendedores.editar' : 'vendedores.baja';
}

function exigir(yo: UsuarioSesion, permiso: string): void {
  if (!yo.permisos.has(permiso)) throw errorHttp(403, 'No tenés permiso para esta acción');
}

function puedeVer(yo: UsuarioSesion, rol: Rol): boolean {
  return yo.permisos.has('usuarios.administrar') || (rol === 'vendedor' && yo.permisos.has('vendedores.ver'));
}

function noASiMismo(yo: UsuarioSesion, objetivo: Objetivo, accion: string): void {
  if (yo.id === objetivo.id) throw errorHttp(400, `No podés ${accion} tu propio usuario`);
}

async function exigirOtroAdmin(db: pg.Pool | pg.PoolClient, objetivo: Objetivo): Promise<void> {
  if (objetivo.rol !== 'admin' || !objetivo.activo) return;
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM usuarios WHERE rol = 'admin' AND activo AND id <> $1",
    [objetivo.id],
  );
  if (!rows[0]?.n) throw errorHttp(400, 'Tiene que quedar al menos un admin activo');
}

/** Busca el usuario objetivo; 404 también si quien pregunta no puede verlo. */
async function buscarObjetivo(db: pg.Pool | pg.PoolClient, yo: UsuarioSesion, id: number): Promise<Objetivo> {
  const { rows } = await db.query<Objetivo>('SELECT id, rol, activo FROM usuarios WHERE id = $1', [id]);
  const objetivo = rows[0];
  if (!objetivo || !puedeVer(yo, objetivo.rol)) throw errorHttp(404, 'Usuario no encontrado');
  return objetivo;
}

export function generarClaveSip(): string {
  return randomBytes(18).toString('base64url');
}

/** Siguiente interno SIP libre desde PRIMER_INTERNO. Llamar dentro de una transacción. */
export async function siguienteInterno(tx: pg.PoolClient): Promise<string> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('usuarios.interno_sip'))");
  const { rows } = await tx.query<{ n: number }>(
    `SELECT GREATEST(COALESCE(MAX(interno_sip::int) + 1, 0), $1)::int AS n
       FROM usuarios WHERE interno_sip ~ '^[0-9]+$'`,
    [PRIMER_INTERNO],
  );
  return String(rows[0]!.n);
}

// --- Rutas ---

export function rutasUsuarios(app: FastifyInstance, { db, redis, sesiones }: Dependencias): void {
  // Asterisk regenera los internos cuando cambia un usuario
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && req.url.startsWith('/api/usuarios') && reply.statusCode < 300) {
      await publicarEvento(redis, 'usuarios.actualizados');
    }
  });
  const verUsuarios = requierePermiso('usuarios.administrar', 'vendedores.ver');

  // Catálogo de permisos agrupado por área, para la pantalla de permisos
  app.get('/api/permisos', { preHandler: requierePermiso('usuarios.permisos') }, async () => {
    const { rows } = await db.query(
      `SELECT p.codigo, p.area, p.descripcion,
              array_agg(rp.rol ORDER BY rp.rol) FILTER (WHERE rp.rol IS NOT NULL) AS roles
         FROM permisos p LEFT JOIN rol_permisos rp ON rp.permiso = p.codigo
        GROUP BY p.codigo ORDER BY p.orden`,
    );
    return rows;
  });

  app.get('/api/usuarios', { preHandler: verUsuarios }, async (req) => {
    const yo = usuarioDe(req);
    const filtro = validar(
      z.object({ rol: z.enum(ROLES).optional(), incluir_bajas: z.enum(['true', 'false']).optional() }),
      req.query,
    );
    // Sin 'usuarios.administrar' solo se ven vendedores
    const rol = yo.permisos.has('usuarios.administrar') ? filtro.rol : 'vendedor';
    if (filtro.rol && filtro.rol !== rol) return [];

    const { rows } = await db.query(
      `SELECT ${COLUMNAS} FROM usuarios
        WHERE ($1::text IS NULL OR rol = $1) AND ($2 OR activo)
        ORDER BY activo DESC, rol, nombre`,
      [rol ?? null, filtro.incluir_bajas === 'true'],
    );
    return rows;
  });

  app.get('/api/usuarios/:id', { preHandler: verUsuarios }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    await buscarObjetivo(db, yo, id);

    const [usuario, excepciones, efectivos] = await Promise.all([
      db.query(`SELECT ${COLUMNAS} FROM usuarios WHERE id = $1`, [id]),
      db.query('SELECT permiso, concedido FROM usuario_permisos WHERE usuario_id = $1 ORDER BY permiso', [id]),
      db.query<{ codigo: string }>(
        `SELECT p.codigo FROM usuarios u CROSS JOIN permisos p
           LEFT JOIN rol_permisos rp ON rp.rol = u.rol AND rp.permiso = p.codigo
           LEFT JOIN usuario_permisos up ON up.usuario_id = u.id AND up.permiso = p.codigo
          WHERE u.id = $1 AND COALESCE(up.concedido, rp.permiso IS NOT NULL) ORDER BY p.orden`,
        [id],
      ),
    ]);
    return {
      ...usuario.rows[0],
      excepciones_permisos: excepciones.rows,
      permisos: efectivos.rows.map((r) => r.codigo),
    };
  });

  app.post('/api/usuarios', { preHandler: verUsuarios }, async (req, reply) => {
    const yo = usuarioDe(req);
    const datos = validar(esquemaAlta, req.body);
    exigir(yo, permisoGestion(datos.rol, 'editar'));
    if (datos.recibe_ivr !== undefined || datos.recibe_leads !== undefined) exigir(yo, 'vendedores.ivr');

    const passwordHash = await hashearClave(datos.clave);
    try {
      const creado = await conTransaccion(db, async (tx) => {
        const interno = await siguienteInterno(tx);
        const { rows } = await tx.query(
          `INSERT INTO usuarios (nombre, usuario, password_hash, rol, sede_id, interno_sip, clave_sip,
                                 tipo_telefono, puede_marcar_manual, recibe_ivr, tope_llamadas, recibe_leads)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'navegador'), COALESCE($9, false),
                   COALESCE($10, true), $11, COALESCE($12, $4 = 'vendedor' AND COALESCE($10, true)))
           RETURNING ${COLUMNAS}`,
          [
            datos.nombre, datos.usuario, passwordHash, datos.rol, datos.sede_id ?? null,
            interno, generarClaveSip(), datos.tipo_telefono ?? null,
            datos.puede_marcar_manual ?? null, datos.recibe_ivr ?? null, datos.tope_llamadas ?? null,
            datos.recibe_leads ?? null,
          ],
        );
        const nuevo = rows[0] as { id: number };
        const { clave: _clave, ...detalle } = datos;
        await registrarEnBitacora(tx, {
          usuarioId: yo.id, accion: 'usuario.crear', entidad: 'usuarios', entidadId: nuevo.id, detalle, ip: req.ip,
        });
        return nuevo;
      });
      return reply.code(201).send(creado);
    } catch (err) {
      if (codigoPg(err) === '23505') throw errorHttp(409, `El usuario "${datos.usuario}" ya existe`);
      if (codigoPg(err) === '23503') throw errorHttp(400, 'La sede indicada no existe');
      throw err;
    }
  });

  app.patch('/api/usuarios/:id', { preHandler: verUsuarios }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const cambios = validar(esquemaEdicion, req.body);

    return conTransaccion(db, async (tx) => {
      const objetivo = await buscarObjetivo(tx, yo, id);
      exigir(yo, permisoGestion(objetivo.rol, 'editar'));
      if (cambios.recibe_ivr !== undefined || cambios.recibe_leads !== undefined) exigir(yo, 'vendedores.ivr');
      if (cambios.rol !== undefined && cambios.rol !== objetivo.rol) {
        exigir(yo, 'usuarios.administrar');
        noASiMismo(yo, objetivo, 'cambiar el rol de');
        await exigirOtroAdmin(tx, objetivo);
      }

      const { rows: antes } = await tx.query(`SELECT ${COLUMNAS} FROM usuarios WHERE id = $1`, [id]);
      const claves = Object.keys(cambios) as (keyof typeof cambios)[];
      const asignaciones = claves.map((c, i) => `${c} = $${i + 2}`).join(', ');
      try {
        const { rows } = await tx.query(
          `UPDATE usuarios SET ${asignaciones} WHERE id = $1 RETURNING ${COLUMNAS}`,
          [id, ...claves.map((c) => cambios[c])],
        );
        const anterior = antes[0] as Record<string, unknown>;
        await registrarEnBitacora(tx, {
          usuarioId: yo.id, accion: 'usuario.editar', entidad: 'usuarios', entidadId: id, ip: req.ip,
          detalle: { antes: Object.fromEntries(claves.map((c) => [c, anterior[c]])), despues: cambios },
        });
        return rows[0];
      } catch (err) {
        if (codigoPg(err) === '23505') throw errorHttp(409, `El usuario "${cambios.usuario}" ya existe`);
        if (codigoPg(err) === '23503') throw errorHttp(400, 'La sede indicada no existe');
        throw err;
      }
    });
  });

  // Blanqueo de clave por un admin/supervisor autorizado: cierra las sesiones del usuario
  app.post('/api/usuarios/:id/clave', { preHandler: verUsuarios }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { clave } = validar(z.object({ clave: esquemaClave }).strict(), req.body);
    const objetivo = await buscarObjetivo(db, yo, id);
    exigir(yo, permisoGestion(objetivo.rol, 'editar'));
    if (yo.id === id) throw errorHttp(400, 'Para tu propia clave usá /api/auth/clave');

    await db.query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [id, await hashearClave(clave)]);
    await sesiones.destruirDeUsuario(id);
    await registrarEnBitacora(db, {
      usuarioId: yo.id, accion: 'usuario.blanquear_clave', entidad: 'usuarios', entidadId: id, ip: req.ip,
    });
    return { ok: true };
  });

  app.post('/api/usuarios/:id/baja', { preHandler: verUsuarios }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    await conTransaccion(db, async (tx) => {
      const objetivo = await buscarObjetivo(tx, yo, id);
      exigir(yo, permisoGestion(objetivo.rol, 'baja'));
      noASiMismo(yo, objetivo, 'dar de baja');
      await exigirOtroAdmin(tx, objetivo);
      await tx.query('UPDATE usuarios SET activo = false, baja_en = now() WHERE id = $1 AND activo', [id]);
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'usuario.baja', entidad: 'usuarios', entidadId: id, ip: req.ip,
      });
    });
    await sesiones.destruirDeUsuario(id);
    return { ok: true };
  });

  app.post('/api/usuarios/:id/reactivar', { preHandler: verUsuarios }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const objetivo = await buscarObjetivo(db, yo, id);
    exigir(yo, permisoGestion(objetivo.rol, 'editar'));
    await db.query('UPDATE usuarios SET activo = true, baja_en = NULL WHERE id = $1', [id]);
    await registrarEnBitacora(db, {
      usuarioId: yo.id, accion: 'usuario.reactivar', entidad: 'usuarios', entidadId: id, ip: req.ip,
    });
    return { ok: true };
  });

  app.delete('/api/usuarios/:id', { preHandler: verUsuarios }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    try {
      await conTransaccion(db, async (tx) => {
        const objetivo = await buscarObjetivo(tx, yo, id);
        exigir(yo, permisoGestion(objetivo.rol, 'baja'));
        noASiMismo(yo, objetivo, 'borrar');
        await exigirOtroAdmin(tx, objetivo);
        const { rows } = await tx.query('DELETE FROM usuarios WHERE id = $1 RETURNING usuario, rol', [id]);
        await registrarEnBitacora(tx, {
          usuarioId: yo.id, accion: 'usuario.borrar', entidad: 'usuarios', entidadId: id, detalle: rows[0], ip: req.ip,
        });
      });
    } catch (err) {
      if (codigoPg(err) === '23503') {
        throw errorHttp(409, 'El usuario tiene llamadas registradas: no se puede borrar, solo dar de baja');
      }
      throw err;
    }
    await sesiones.destruirDeUsuario(id);
    return { ok: true };
  });

  // Reemplaza las excepciones de permisos del usuario (solo las de permisos que quien edita tiene)
  app.put('/api/usuarios/:id/permisos', { preHandler: requierePermiso('usuarios.permisos') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { excepciones } = validar(
      z.object({
        excepciones: z.array(z.object({ permiso: z.string().min(1), concedido: z.boolean() }).strict()).max(200),
      }).strict(),
      req.body,
    );

    const ajenos = excepciones.filter((e) => !yo.permisos.has(e.permiso)).map((e) => e.permiso);
    if (ajenos.length) throw errorHttp(403, `No podés asignar permisos que no tenés: ${ajenos.join(', ')}`);

    return conTransaccion(db, async (tx) => {
      const objetivo = await buscarObjetivo(tx, yo, id);
      noASiMismo(yo, objetivo, 'editar los permisos de');
      if (objetivo.rol !== 'vendedor') exigir(yo, 'usuarios.administrar');

      const { rows: antes } = await tx.query(
        'SELECT permiso, concedido FROM usuario_permisos WHERE usuario_id = $1 ORDER BY permiso',
        [id],
      );
      // Las excepciones sobre permisos que quien edita no tiene se conservan
      await tx.query('DELETE FROM usuario_permisos WHERE usuario_id = $1 AND permiso = ANY($2)', [
        id,
        [...yo.permisos],
      ]);
      try {
        // Solo se guardan las que difieren de lo que ya da el rol
        await tx.query(
          `INSERT INTO usuario_permisos (usuario_id, permiso, concedido)
           SELECT $1, e.permiso, e.concedido
             FROM jsonb_to_recordset($2::jsonb) AS e(permiso text, concedido boolean)
            WHERE e.concedido IS DISTINCT FROM EXISTS (
                    SELECT 1 FROM rol_permisos rp WHERE rp.rol = $3 AND rp.permiso = e.permiso)`,
          [id, JSON.stringify(excepciones), objetivo.rol],
        );
      } catch (err) {
        if (codigoPg(err) === '23503') throw errorHttp(400, 'Algún permiso indicado no existe');
        if (codigoPg(err) === '23505') throw errorHttp(400, 'Hay permisos repetidos');
        throw err;
      }
      const { rows: despues } = await tx.query(
        'SELECT permiso, concedido FROM usuario_permisos WHERE usuario_id = $1 ORDER BY permiso',
        [id],
      );
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'usuario.permisos', entidad: 'usuarios', entidadId: id, ip: req.ip,
        detalle: { antes, despues },
      });
      return { excepciones_permisos: despues };
    });
  });
}
