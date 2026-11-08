// Catálogos y parámetros del panel (§3, §7, §9, §13, §16):
// gateways, tipificaciones, motivos de descanso, sedes, bloqueos, horario global y configuración.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registrarEnBitacora } from '../bitacora.js';
import { PARAMETROS, esClaveConfig } from '../configuracion.js';
import { conTransaccion } from '../db/transaccion.js';
import { publicarEvento } from '../eventos.js';
import { requierePermiso, requiereSesion, usuarioDe } from './autenticacion.js';
import { rutasCatalogo } from './catalogo.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato HH:MM');

export function rutasAdministracion(app: FastifyInstance, deps: Dependencias): void {
  const { db, redis } = deps;

  rutasCatalogo(app, deps, {
    ruta: '/api/gateways',
    tabla: 'gateways',
    entidad: 'gateway',
    columnas: `id, nombre, endpoint_pjsip, host(ip) AS ip, canales, canales_reservados_manual,
               llamadas_por_segundo::float8 AS llamadas_por_segundo, orden, activo, creado_en`,
    orden: 'orden, id',
    campos: {
      nombre: z.string().trim().min(1).max(60),
      endpoint_pjsip: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'letras, números, _ o -'),
      ip: z.string().ip({ version: 'v4' }).nullable(),
      canales: z.number().int().min(1).max(512),
      canales_reservados_manual: z.number().int().min(0).max(512),
      llamadas_por_segundo: z.number().positive().max(100).nullable(),
      orden: z.number().int().min(0).max(1000),
      activo: z.boolean(),
    },
    requeridos: ['nombre', 'endpoint_pjsip', 'canales'],
    columnaActivo: 'activo',
    ver: requierePermiso('gateways.ver'),
    editar: requierePermiso('gateways.editar'),
    evento: 'gateways.actualizados',
  });

  rutasCatalogo(app, deps, {
    ruta: '/api/tipificaciones',
    tabla: 'tipificaciones',
    entidad: 'tipificacion',
    columnas: 'id, nombre, es_final, es_venta, es_contestador, reintentar_en_min, marca_no_llame, orden, activa',
    orden: 'orden, nombre',
    campos: {
      nombre: z.string().trim().min(1).max(80),
      es_final: z.boolean(),
      es_venta: z.boolean(),
      reintentar_en_min: z.number().int().min(1).max(43_200).nullable(),
      marca_no_llame: z.boolean(),
      es_contestador: z.boolean(),
      orden: z.number().int().min(0).max(1000),
      activa: z.boolean(),
    },
    requeridos: ['nombre'],
    columnaActivo: 'activa',
    ver: requiereSesion, // el vendedor las necesita para tipificar
    editar: requierePermiso('config.tipificacion'),
    evento: 'tipificaciones.actualizadas',
  });

  rutasCatalogo(app, deps, {
    ruta: '/api/motivos-descanso',
    tabla: 'motivos_descanso',
    entidad: 'motivo_descanso',
    columnas: 'id, nombre, max_minutos, orden, visible, activo',
    orden: 'orden, nombre',
    campos: {
      nombre: z.string().trim().min(1).max(60),
      max_minutos: z.number().int().min(1).max(600).nullable(),
      orden: z.number().int().min(0).max(1000),
      visible: z.boolean(),
      activo: z.boolean(),
    },
    requeridos: ['nombre'],
    columnaActivo: 'activo',
    ver: requiereSesion,
    editar: requierePermiso('config.descansos'),
    evento: 'descansos.actualizados',
  });

  rutasCatalogo(app, deps, {
    ruta: '/api/sedes',
    tabla: 'sedes',
    entidad: 'sede',
    columnas: 'id, nombre, activa, creada_en',
    orden: 'nombre',
    campos: { nombre: z.string().trim().min(1).max(80), activa: z.boolean() },
    requeridos: ['nombre'],
    columnaActivo: 'activa',
    ver: requiereSesion,
    editar: requierePermiso('config.sedes'),
  });

  rutasCatalogo(app, deps, {
    ruta: '/api/bloqueos',
    tabla: 'bloqueos_horario',
    entidad: 'bloqueo',
    columnas: `id, tipo, dia_semana, fecha::text AS fecha, to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
               to_char(hora_fin, 'HH24:MI') AS hora_fin, campana_id, motivo, activo, creado_por, creado_en`,
    orden: 'activo DESC, tipo, fecha, dia_semana, hora_inicio',
    campos: {
      tipo: z.enum(['semanal', 'fecha']),
      dia_semana: z.number().int().min(1).max(7).nullable(),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato AAAA-MM-DD').nullable(),
      hora_inicio: hora.nullable(),
      hora_fin: hora.nullable(),
      campana_id: z.number().int().positive().nullable(),
      motivo: z.string().trim().min(1).max(200),
      activo: z.boolean(),
    },
    requeridos: ['tipo', 'motivo'],
    columnaActivo: 'activo',
    ver: requierePermiso('config.horario', 'campanas.ver'),
    editar: requierePermiso('config.horario'),
    evento: 'horario.actualizado',
    extrasAlta: (yo) => ({ creado_por: yo.id }),
  });

  // --- Horario global: se reemplaza entero ---

  app.get('/api/horario', { preHandler: requiereSesion }, async () => {
    const { rows } = await db.query(
      `SELECT dia_semana, to_char(hora_inicio, 'HH24:MI') AS hora_inicio, to_char(hora_fin, 'HH24:MI') AS hora_fin
         FROM horario_global ORDER BY dia_semana, hora_inicio`,
    );
    return rows;
  });

  app.put('/api/horario', { preHandler: requierePermiso('config.horario') }, async (req) => {
    const yo = usuarioDe(req);
    const { franjas } = validar(
      z.object({
        franjas: z
          .array(z.object({ dia_semana: z.number().int().min(1).max(7), hora_inicio: hora, hora_fin: hora }).strict())
          .max(50),
      }).strict(),
      req.body,
    );
    // Franjas del mismo día no se pueden pisar
    for (const a of franjas) {
      if (a.hora_inicio >= a.hora_fin) throw errorHttp(400, `Día ${a.dia_semana}: la hora de inicio tiene que ser anterior a la de fin`);
      const pisada = franjas.find(
        (b) => b !== a && b.dia_semana === a.dia_semana && a.hora_inicio < b.hora_fin && b.hora_inicio < a.hora_fin,
      );
      if (pisada) throw errorHttp(400, `Día ${a.dia_semana}: hay franjas que se superponen`);
    }
    await conTransaccion(db, async (tx) => {
      const { rows: antes } = await tx.query(
        "SELECT dia_semana, to_char(hora_inicio, 'HH24:MI') AS hora_inicio, to_char(hora_fin, 'HH24:MI') AS hora_fin FROM horario_global ORDER BY 1, 2",
      );
      await tx.query('DELETE FROM horario_global');
      await tx.query(
        `INSERT INTO horario_global (dia_semana, hora_inicio, hora_fin)
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS f(dia_semana smallint, hora_inicio time, hora_fin time)`,
        [JSON.stringify(franjas)],
      );
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'horario.editar', entidad: 'horario_global', ip: req.ip, detalle: { antes, despues: franjas },
      });
    });
    await publicarEvento(redis, 'horario.actualizado');
    return { ok: true };
  });

  // --- Configuración global: cada clave con su tipo y su permiso ---

  app.get('/api/configuracion', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const { rows } = await db.query<{ clave: string; valor: unknown; actualizado_en: Date; actualizado_por: number | null }>(
      'SELECT clave, valor, actualizado_en, actualizado_por FROM configuracion ORDER BY clave',
    );
    return rows
      .filter((r) => esClaveConfig(r.clave))
      .map((r) => ({ ...r, editable: yo.permisos.has(PARAMETROS[r.clave as keyof typeof PARAMETROS].permiso) }));
  });

  // Cuerpo: { "amd.saludo_max_ms": 1800, "ritmo.adaptativo": false, ... }
  app.patch('/api/configuracion', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const cambios = validar(z.record(z.unknown()).refine((d) => Object.keys(d).length > 0, 'no hay cambios'), req.body);

    const validados: Record<string, unknown> = {};
    for (const [clave, valor] of Object.entries(cambios)) {
      if (!esClaveConfig(clave)) throw errorHttp(400, `Parámetro desconocido: ${clave}`);
      const def = PARAMETROS[clave];
      if (!yo.permisos.has(def.permiso)) throw errorHttp(403, `No tenés permiso para cambiar ${clave}`);
      const r = def.esquema.safeParse(valor);
      if (!r.success) throw errorHttp(400, `${clave}: ${r.error.issues[0]?.message}`);
      validados[clave] = r.data;
    }

    await conTransaccion(db, async (tx) => {
      const { rows: antes } = await tx.query<{ clave: string; valor: unknown }>(
        'SELECT clave, valor FROM configuracion WHERE clave = ANY($1)',
        [Object.keys(validados)],
      );
      for (const [clave, valor] of Object.entries(validados)) {
        await tx.query(
          `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por) VALUES ($1, $2, now(), $3)
           ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now(), actualizado_por = $3`,
          [clave, JSON.stringify(valor), yo.id],
        );
      }
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'configuracion.editar', entidad: 'configuracion', ip: req.ip,
        detalle: { antes: Object.fromEntries(antes.map((r) => [r.clave, r.valor])), despues: validados },
      });
    });
    await publicarEvento(redis, 'config.actualizada', { claves: Object.keys(validados) });
    return { ok: true, cambios: validados };
  });

  // --- Bitácora ---

  app.get('/api/bitacora', { preHandler: requierePermiso('bitacora.ver') }, async (req) => {
    const f = validar(
      z.object({
        usuario_id: z.coerce.number().int().positive().optional(),
        accion: z.string().max(60).optional(),
        desde: z.string().datetime({ offset: true }).optional(),
        hasta: z.string().datetime({ offset: true }).optional(),
        limite: z.coerce.number().int().min(1).max(500).default(100),
        antes_de_id: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const { rows } = await db.query(
      `SELECT b.id, b.ts, b.usuario_id, u.nombre AS usuario_nombre, b.accion, b.entidad, b.entidad_id, b.detalle, host(b.ip) AS ip
         FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id
        WHERE ($1::int IS NULL OR b.usuario_id = $1)
          AND ($2::text IS NULL OR b.accion LIKE $2 || '%')
          AND ($3::timestamptz IS NULL OR b.ts >= $3)
          AND ($4::timestamptz IS NULL OR b.ts < $4)
          AND ($6::bigint IS NULL OR b.id < $6)
        ORDER BY b.id DESC LIMIT $5`,
      [f.usuario_id ?? null, f.accion ?? null, f.desde ?? null, f.hasta ?? null, f.limite, f.antes_de_id ?? null],
    );
    return rows;
  });
}
