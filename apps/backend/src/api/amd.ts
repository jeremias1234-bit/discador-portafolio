// Revisión del AMD (§5): se escucha la grabación de la detección de las llamadas atendidas y se
// marca si el AMD acertó. Con eso se mide el error real antes de tocar los parámetros.
//   - Contestador (MACHINE) que en realidad era una persona = se cortó a un cliente.
//   - Persona (HUMAN) o dudosa que era contestador = le llegó una máquina al vendedor
//     (lo marca solo el vendedor al tipificar "Contestador").
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requierePermiso, usuarioDe } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato AAAA-MM-DD');
const POR_PAGINA = 50;

// Rango en la zona configurada ($1 desde, $2 hasta, $3 zona) y campaña opcional ($4)
const RANGO = `l.inicio >= ($1::date)::timestamp AT TIME ZONE $3 AND l.inicio < ($2::date + 1)::timestamp AT TIME ZONE $3
  AND ($4::int IS NULL OR l.campana_id = $4) AND l.amd_estado IS NOT NULL`;

export function rutasAmd(app: FastifyInstance, { db, ari, configuracion }: Dependencias): void {
  const permiso = requierePermiso('config.amd');

  async function rango(q: unknown) {
    const f = validar(
      z.object({ desde: fecha.optional(), hasta: fecha.optional(), campana_id: z.coerce.number().int().positive().optional() }).passthrough(),
      q,
    );
    const zona = (await configuracion.obtener())['general.zona_horaria'];
    const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: zona });
    return { desde: f.desde ?? hoy, hasta: f.hasta ?? f.desde ?? hoy, zona, campana: f.campana_id ?? null };
  }

  // Resumen: cuántas clasificó cada resultado, cuántas se revisaron y cuántas estaban mal
  app.get('/api/amd/resumen', { preHandler: permiso }, async (req) => {
    const r = await rango(req.query);
    const { rows } = await db.query(
      `SELECT l.amd_estado, count(*)::int AS llamadas,
              count(*) FILTER (WHERE l.amd_revision IS NOT NULL)::int AS revisadas,
              count(*) FILTER (WHERE l.amd_revision = 'error')::int AS errores,
              count(*) FILTER (WHERE t.es_contestador)::int AS contestador_segun_vendedor,
              count(*) FILTER (WHERE l.amd_grabacion_path IS NOT NULL)::int AS con_audio
         FROM llamadas l LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id
        WHERE ${RANGO} GROUP BY 1 ORDER BY llamadas DESC`,
      [r.desde, r.hasta, r.zona, r.campana],
    );
    return rows;
  });

  app.get('/api/amd/revision', { preHandler: permiso }, async (req) => {
    const r = await rango(req.query);
    const f = validar(
      z.object({
        estado: z.enum(['MACHINE', 'NOTSURE', 'HUMAN', 'HANGUP']).optional(),
        revision: z.enum(['pendiente', 'acerto', 'error']).optional(),
        pagina: z.coerce.number().int().min(1).default(1),
      }).passthrough(),
      req.query,
    );
    const { rows } = await db.query(
      `SELECT l.id, l.inicio, l.telefono, c.nombre AS campana, l.amd_estado, l.amd_causa, l.resultado,
              t.nombre AS tipificacion, coalesce(t.es_contestador, false) AS contestador_segun_vendedor,
              l.amd_revision, u.nombre AS revisado_por, (l.amd_grabacion_path IS NOT NULL) AS tiene_audio,
              count(*) OVER ()::int AS total
         FROM llamadas l
         LEFT JOIN campanas c ON c.id = l.campana_id LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id
         LEFT JOIN usuarios u ON u.id = l.amd_revisado_por
        WHERE ${RANGO}
          AND ($5::text IS NULL OR l.amd_estado = $5)
          AND ($6::text IS NULL OR ($6 = 'pendiente' AND l.amd_revision IS NULL) OR l.amd_revision = $6)
        ORDER BY l.inicio DESC LIMIT $7 OFFSET $8`,
      [r.desde, r.hasta, r.zona, r.campana, f.estado ?? null, f.revision ?? null, POR_PAGINA, (f.pagina - 1) * POR_PAGINA],
    );
    return { total: rows[0]?.total ?? 0, pagina: f.pagina, por_pagina: POR_PAGINA, llamadas: rows.map(({ total: _t, ...x }) => x) };
  });

  app.get('/api/amd/:id/audio', { preHandler: permiso }, async (req, reply) => {
    const { id } = validar(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { rows } = await db.query<{ amd_grabacion_path: string | null }>('SELECT amd_grabacion_path FROM llamadas WHERE id = $1', [id]);
    if (!rows[0]?.amd_grabacion_path) throw errorHttp(404, 'La llamada no tiene grabación de la detección');
    const respuesta = await ari.descargarGrabacion(rows[0].amd_grabacion_path);
    if (!respuesta.ok || !respuesta.body) throw errorHttp(404, 'La grabación ya no está en el servidor');
    reply.type('audio/wav');
    const largo = respuesta.headers.get('content-length');
    if (largo) reply.header('Content-Length', largo);
    return reply.send(Readable.fromWeb(respuesta.body as import('node:stream/web').ReadableStream));
  });

  // Veredicto: 'acerto' / 'error' (null = volver a pendiente)
  app.post('/api/amd/:id/revision', { preHandler: permiso }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { veredicto } = validar(z.object({ veredicto: z.enum(['acerto', 'error']).nullable() }).strict(), req.body);
    const { rowCount } = await db.query(
      `UPDATE llamadas SET amd_revision = $2, amd_revisado_por = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::int END,
              amd_revisado_en = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
        WHERE id = $1 AND amd_estado IS NOT NULL`,
      [id, veredicto, yo.id],
    );
    if (!rowCount) throw errorHttp(404, 'Llamada sin detección de contestador');
    return { ok: true };
  });
}
