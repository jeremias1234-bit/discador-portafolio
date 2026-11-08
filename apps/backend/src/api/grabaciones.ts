// Grabaciones (§11): búsqueda, reproducción, descarga y retención automática.
// Asterisk las guarda en /var/spool/asterisk/recording/llamada-<id>.wav; el backend las sirve
// y las borra por ARI, así no necesita permisos sobre los archivos.
import { statfs } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AriCliente } from '../ari/cliente.js';
import { registrarEnBitacora } from '../bitacora.js';
import { config } from '../config.js';
import type { CacheConfiguracion } from '../configuracion.js';
import { requierePermiso, usuarioDe } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const INTERVALO_RETENCION_MS = 60 * 60_000;
const LOTE_BORRADO = 200;
const BYTES_POR_SEGUNDO_WAV = 16_000; // 8 kHz, 16 bits, mono

async function espacioLibreGb(): Promise<number | null> {
  try {
    const s = await statfs(config.DIR_GRABACIONES);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

/**
 * Borra las grabaciones vencidas (más viejas que la retención) y, si el disco queda por debajo
 * del piso libre, sigue con las más viejas hasta recuperarlo. Devuelve cuántas borró.
 */
export async function aplicarRetencion(db: pg.Pool, ari: AriCliente, configuracion: CacheConfiguracion): Promise<number> {
  const c = await configuracion.obtener();
  let borradas = 0;

  const borrar = async (filas: { id: number; grabacion_path: string }[]) => {
    for (const f of filas) {
      await ari.borrarGrabacion(f.grabacion_path).catch(() => {}); // si ya no existe, igual se limpia la referencia
      await db.query('UPDATE llamadas SET grabacion_path = NULL WHERE id = $1', [f.id]);
      borradas++;
    }
  };

  for (;;) {
    const { rows } = await db.query<{ id: number; grabacion_path: string }>(
      `SELECT id, grabacion_path FROM llamadas
        WHERE grabacion_path IS NOT NULL AND inicio < now() - make_interval(days => $1)
        ORDER BY inicio LIMIT $2`,
      [c['grabaciones.retencion_dias'], LOTE_BORRADO],
    );
    if (rows.length === 0) break;
    await borrar(rows);
  }

  // Grabaciones de la detección de contestador (Revisión de AMD): misma retención
  for (;;) {
    const { rows } = await db.query<{ id: number; amd_grabacion_path: string }>(
      `SELECT id, amd_grabacion_path FROM llamadas
        WHERE amd_grabacion_path IS NOT NULL AND inicio < now() - make_interval(days => $1)
        ORDER BY inicio LIMIT $2`,
      [c['grabaciones.retencion_dias'], LOTE_BORRADO],
    );
    if (rows.length === 0) break;
    for (const f of rows) {
      await ari.borrarGrabacion(f.amd_grabacion_path).catch(() => {});
      await db.query('UPDATE llamadas SET amd_grabacion_path = NULL WHERE id = $1', [f.id]);
      borradas++;
    }
  }

  // Piso de disco libre: se estima lo que libera cada grabación por su duración
  let libre = await espacioLibreGb();
  while (libre !== null && libre < c['grabaciones.piso_disco_libre_gb']) {
    const { rows } = await db.query<{ id: number; grabacion_path: string; seg: number }>(
      `SELECT id, grabacion_path, coalesce(EXTRACT(EPOCH FROM (fin - conectada_vendedor_en)), 0)::int AS seg
         FROM llamadas WHERE grabacion_path IS NOT NULL AND fin IS NOT NULL ORDER BY inicio LIMIT $1`,
      [LOTE_BORRADO],
    );
    if (rows.length === 0) break;
    await borrar(rows);
    libre += rows.reduce((s, r) => s + (r.seg * BYTES_POR_SEGUNDO_WAV) / 1024 ** 3, 0);
    libre = Math.max(libre, (await espacioLibreGb()) ?? libre);
  }
  return borradas;
}

export function rutasGrabaciones(app: FastifyInstance, { db, ari, configuracion }: Dependencias): void {
  const t = setInterval(() => {
    aplicarRetencion(db, ari, configuracion)
      .then((n) => n > 0 && app.log.info({ borradas: n }, 'Retención de grabaciones aplicada'))
      .catch((err: unknown) => app.log.error({ err }, 'Error aplicando la retención de grabaciones'));
  }, INTERVALO_RETENCION_MS);
  app.addHook('onClose', async () => clearInterval(t));

  app.get('/api/grabaciones', { preHandler: requierePermiso('grabaciones.escuchar') }, async (req) => {
    const c = await configuracion.obtener();
    const f = validar(
      z.object({
        vendedor_id: z.coerce.number().int().positive().optional(),
        campana_id: z.coerce.number().int().positive().optional(),
        telefono: z.string().regex(/^\d+$/, 'solo dígitos').optional(),
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        duracion_min: z.coerce.number().int().min(0).optional(),
        origen: z.enum(['discador', 'manual', 'ivr']).optional(),
        solo_ventas: z.enum(['true', 'false']).optional(),
        pagina: z.coerce.number().int().min(1).default(1),
      }),
      req.query,
    );
    const porPagina = c['grabaciones.por_pagina'];
    const { rows } = await db.query(
      `SELECT l.id, l.inicio, l.telefono, l.origen, l.campana_id, c.nombre AS campana, l.vendedor_id, u.nombre AS vendedor,
              t.nombre AS tipificacion, coalesce(t.es_venta, false) AS es_venta, l.notas,
              EXTRACT(EPOCH FROM (l.fin - l.conectada_vendedor_en))::int AS duracion_seg,
              count(*) OVER ()::int AS total
         FROM llamadas l
         LEFT JOIN campanas c ON c.id = l.campana_id LEFT JOIN usuarios u ON u.id = l.vendedor_id
         LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id
        WHERE l.grabacion_path IS NOT NULL AND l.fin IS NOT NULL
          AND ($1::int IS NULL OR l.vendedor_id = $1) AND ($2::int IS NULL OR l.campana_id = $2)
          AND ($3::text IS NULL OR l.telefono LIKE '%' || $3 || '%')
          AND ($4::date IS NULL OR l.inicio >= ($4::date)::timestamp AT TIME ZONE $10)
          AND ($5::date IS NULL OR l.inicio < ($5::date + 1)::timestamp AT TIME ZONE $10)
          AND ($6::int IS NULL OR l.fin - l.conectada_vendedor_en >= make_interval(secs => $6))
          AND ($7::text IS NULL OR l.origen = $7) AND (NOT $8 OR t.es_venta)
        ORDER BY l.inicio DESC LIMIT $9 OFFSET $11`,
      [
        f.vendedor_id ?? null, f.campana_id ?? null, f.telefono ?? null, f.desde ?? null, f.hasta ?? null,
        f.duracion_min ?? null, f.origen ?? null, f.solo_ventas === 'true', porPagina, c['general.zona_horaria'],
        (f.pagina - 1) * porPagina,
      ],
    );
    return { total: rows[0]?.total ?? 0, pagina: f.pagina, por_pagina: porPagina, grabaciones: rows.map(({ total: _t, ...r }) => r) };
  });

  // Reproducción (y descarga con ?descargar=true, que pide su propio permiso)
  app.get('/api/grabaciones/:id/audio', { preHandler: requierePermiso('grabaciones.escuchar') }, async (req, reply) => {
    const yo = usuarioDe(req);
    const { id } = validar(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { descargar } = validar(z.object({ descargar: z.enum(['true', 'false']).optional() }), req.query);
    const { rows } = await db.query<{ grabacion_path: string | null; telefono: string; inicio: Date }>(
      'SELECT grabacion_path, telefono, inicio FROM llamadas WHERE id = $1',
      [id],
    );
    const g = rows[0];
    if (!g?.grabacion_path) throw errorHttp(404, 'La llamada no tiene grabación');

    const respuesta = await ari.descargarGrabacion(g.grabacion_path);
    if (!respuesta.ok || !respuesta.body) throw errorHttp(404, 'La grabación ya no está en el servidor');
    reply.type('audio/wav');
    const largo = respuesta.headers.get('content-length');
    if (largo) reply.header('Content-Length', largo);
    if (descargar === 'true') {
      if (!yo.permisos.has('grabaciones.descargar')) throw errorHttp(403, 'No tenés permiso para descargar grabaciones');
      const fecha = g.inicio.toISOString().slice(0, 19).replace(/[T:]/g, '-');
      reply.header('Content-Disposition', `attachment; filename="llamada-${id}_${g.telefono}_${fecha}.wav"`);
      await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'grabacion.descargar', entidad: 'llamadas', entidadId: id, ip: req.ip });
    }
    return reply.send(Readable.fromWeb(respuesta.body as import('node:stream/web').ReadableStream));
  });

  // Espacio libre y días guardados
  app.get('/api/grabaciones/estado', { preHandler: requierePermiso('grabaciones.escuchar', 'config.grabaciones') }, async () => {
    const c = await configuracion.obtener();
    const { rows } = await db.query(
      `SELECT count(*)::int AS grabaciones, min(inicio) AS mas_vieja,
              EXTRACT(DAY FROM now() - min(inicio))::int AS dias_guardados
         FROM llamadas WHERE grabacion_path IS NOT NULL`,
    );
    const libre = await espacioLibreGb();
    return {
      ...rows[0],
      espacio_libre_gb: libre === null ? null : Math.round(libre * 10) / 10,
      piso_disco_libre_gb: c['grabaciones.piso_disco_libre_gb'],
      retencion_dias: c['grabaciones.retencion_dias'],
    };
  });

  app.post('/api/grabaciones/aplicar-retencion', { preHandler: requierePermiso('config.grabaciones') }, async (req) => {
    const yo = usuarioDe(req);
    const borradas = await aplicarRetencion(db, ari, configuracion);
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'grabaciones.retencion', detalle: { borradas }, ip: req.ip });
    return { borradas };
  });
}
