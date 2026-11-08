// Puesto del vendedor (§9): estado y descansos, llamada manual, colgar, tipificar,
// pendientes de tipificar y vista previa de campañas manuales.
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizarTelefono } from '../telefonos.js';
import { sqlBloqueado } from '../noLlame.js';
import { requierePermiso, requiereSesion, usuarioDe } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

export function rutasPuesto(app: FastifyInstance, { db, ari, conmutador, configuracion }: Dependencias): void {
  app.get('/api/puesto', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const p = conmutador.puesto(yo.id);
    const config = await configuracion.obtener();
    const [pendientes, campanas] = await Promise.all([
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM llamadas
          WHERE vendedor_id = $1 AND conectada_vendedor_en IS NOT NULL AND tipificacion_id IS NULL AND fin IS NOT NULL
            AND inicio > now() - make_interval(hours => $2)`,
        [yo.id, config['tipificacion.pendientes_horas']],
      ),
      db.query(
        `SELECT c.id, c.nombre, c.tipo FROM campanas c JOIN campana_vendedores cv ON cv.campana_id = c.id
          WHERE cv.usuario_id = $1 AND c.estado = 'activa' ORDER BY c.prioridad DESC, c.nombre`,
        [yo.id],
      ),
    ]);
    return {
      linea_conectada: !!p,
      recibe_ivr: p?.recibeIvr ?? null,
      estado: p?.estado ?? null,
      motivo_descanso_id: p?.motivoDescansoId ?? null,
      desde: p?.desde ?? null,
      llamada_id: p?.llamadaId ?? null,
      ultima_llamada_id: p?.ultimaLlamadaId ?? null,
      pendientes_de_tipificar: pendientes.rows[0]?.n ?? 0,
      tipificacion_obligatoria: config['tipificacion.obligatoria'],
      tono_entrada: config['telefono.tono_entrada'],
      volumen_inicial: config['telefono.volumen_inicial'],
      campanas: campanas.rows,
    };
  });

  app.post('/api/puesto/estado', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const { estado, motivo_descanso_id } = validar(
      z.object({
        estado: z.enum(['disponible', 'descanso']),
        motivo_descanso_id: z.number().int().positive().optional(),
      }).strict(),
      req.body,
    );
    if (estado === 'descanso') {
      const { rows } = await db.query('SELECT 1 FROM motivos_descanso WHERE id = $1 AND activo AND visible', [motivo_descanso_id]);
      if (!rows[0]) throw errorHttp(400, 'Motivo de descanso inválido');
    }
    await conmutador.cambiarEstado(yo.id, estado, motivo_descanso_id);
    return { ok: true, estado };
  });

  app.post('/api/puesto/llamar', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const datos = validar(
      z.object({ telefono: z.string().min(1), lead_id: z.coerce.number().int().positive().optional() }).strict(),
      req.body,
    );
    const telefono = normalizarTelefono(datos.telefono);
    if (!telefono) throw errorHttp(400, 'Número inválido');
    const llamadaId = await conmutador.llamarManual(yo.id, telefono, datos.lead_id);
    return { ok: true, llamada_id: llamadaId, telefono };
  });

  app.post('/api/puesto/probar-audio', { preHandler: requiereSesion }, async (req) => {
    await conmutador.probarAudio(usuarioDe(req).id);
    return { ok: true };
  });

  app.post('/api/puesto/colgar', { preHandler: requiereSesion }, async (req) => {
    await conmutador.colgarDesdePuesto(usuarioDe(req).id);
    return { ok: true };
  });

  app.post('/api/puesto/tipificar', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const t = validar(
      z.object({
        llamada_id: z.coerce.number().int().positive(), // BIGINT: puede venir como texto
        tipificacion_id: z.number().int().positive(),
        notas: z.string().max(2000).optional(),
        reintentar_en_min: z.number().int().min(1).max(43_200).optional(),
      }).strict(),
      req.body,
    );
    await conmutador.tipificar(yo.id, {
      llamadaId: t.llamada_id, tipificacionId: t.tipificacion_id, notas: t.notas, reintentarEnMin: t.reintentar_en_min,
    });
    return { ok: true };
  });

  // Llamadas que llegaron al vendedor y quedaron sin tipificar
  app.get('/api/puesto/pendientes', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const config = await configuracion.obtener();
    const { rows } = await db.query(
      `SELECT l.id, l.telefono, l.inicio, l.fin, l.campana_id, c.nombre AS campana, ld.nombre AS lead_nombre,
              EXTRACT(EPOCH FROM (l.fin - l.conectada_vendedor_en))::int AS duracion_seg
         FROM llamadas l LEFT JOIN campanas c ON c.id = l.campana_id LEFT JOIN leads ld ON ld.id = l.lead_id
        WHERE l.vendedor_id = $1 AND l.conectada_vendedor_en IS NOT NULL AND l.tipificacion_id IS NULL AND l.fin IS NOT NULL
          AND l.inicio > now() - make_interval(hours => $2)
          AND l.fin - l.conectada_vendedor_en >= make_interval(secs => $3)
        ORDER BY l.inicio DESC`,
      [yo.id, config['tipificacion.pendientes_horas'], config['tipificacion.duracion_minima_seg']],
    );
    return rows;
  });

  // Vista previa (campañas manuales): reserva el próximo contacto para que el vendedor decida llamar
  app.post('/api/puesto/siguiente', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const { campana_id } = validar(z.object({ campana_id: z.number().int().positive() }).strict(), req.body);
    const { rows: asignada } = await db.query(
      `SELECT 1 FROM campanas c JOIN campana_vendedores cv ON cv.campana_id = c.id
        WHERE c.id = $1 AND cv.usuario_id = $2 AND c.estado = 'activa' AND c.tipo = 'manual'`,
      [campana_id, yo.id],
    );
    if (!asignada[0]) throw errorHttp(400, 'No estás asignado a esa campaña manual activa');
    const { rows } = await db.query(
      `WITH elegido AS (
         SELECT l.id FROM leads l JOIN listas li ON li.id = l.lista_id AND li.activa
          WHERE l.campana_id = $1 AND l.estado IN ('pendiente', 'reintentar') AND l.proximo_intento <= now()
            AND NOT ${sqlBloqueado('l.telefono')}
          ORDER BY l.prioridad DESC, l.proximo_intento LIMIT 1 FOR UPDATE OF l SKIP LOCKED)
       UPDATE leads SET estado = 'en_curso' FROM elegido WHERE leads.id = elegido.id
       RETURNING leads.id, leads.telefono, leads.nombre, leads.dni, leads.datos, leads.intentos, leads.ultimo_resultado`,
      [campana_id],
    );
    if (!rows[0]) throw errorHttp(404, 'No quedan contactos para llamar en esta campaña');
    return rows[0];
  });

  // Saltear el contacto de la vista previa: vuelve a la cola
  app.post('/api/puesto/saltar', { preHandler: requiereSesion }, async (req) => {
    const { lead_id } = validar(z.object({ lead_id: z.coerce.number().int().positive() }).strict(), req.body);
    await db.query("UPDATE leads SET estado = CASE WHEN intentos = 0 THEN 'pendiente' ELSE 'reintentar' END WHERE id = $1 AND estado = 'en_curso'", [lead_id]);
    return { ok: true };
  });

  // Historial del vendedor: sus llamadas (las que le llegaron o marcó), con tipificación y notas
  app.get('/api/puesto/historial', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const f = validar(
      z.object({
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        telefono: z.string().regex(/^\d*$/, 'solo dígitos').optional(),
        pagina: z.coerce.number().int().min(1).default(1),
      }),
      req.query,
    );
    const config = await configuracion.obtener();
    const porPagina = 50;
    const { rows } = await db.query(
      `SELECT l.id, l.inicio, l.telefono, l.origen, c.nombre AS campana, ld.nombre AS lead_nombre, ld.dni,
              l.resultado, t.nombre AS tipificacion, coalesce(t.es_venta, false) AS es_venta, l.notas,
              EXTRACT(EPOCH FROM (l.fin - l.conectada_vendedor_en))::int AS duracion_seg,
              (l.grabacion_path IS NOT NULL) AS tiene_grabacion, count(*) OVER ()::int AS total
         FROM llamadas l
         LEFT JOIN campanas c ON c.id = l.campana_id LEFT JOIN leads ld ON ld.id = l.lead_id
         LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id
        WHERE l.vendedor_id = $1 AND l.conectada_vendedor_en IS NOT NULL AND l.fin IS NOT NULL
          AND ($2::date IS NULL OR l.inicio >= ($2::date)::timestamp AT TIME ZONE $5)
          AND ($3::date IS NULL OR l.inicio < ($3::date + 1)::timestamp AT TIME ZONE $5)
          AND ($4::text IS NULL OR l.telefono LIKE '%' || $4 || '%')
        ORDER BY l.inicio DESC LIMIT $6 OFFSET $7`,
      [yo.id, f.desde ?? null, f.hasta ?? null, f.telefono || null, config['general.zona_horaria'], porPagina, (f.pagina - 1) * porPagina],
    );
    return { total: rows[0]?.total ?? 0, pagina: f.pagina, por_pagina: porPagina, llamadas: rows.map(({ total: _t, ...r }) => r) };
  });

  // Grabación de una llamada propia (sin el permiso general de grabaciones)
  app.get('/api/puesto/llamadas/:id/audio', { preHandler: requierePermiso('grabaciones.propias') }, async (req, reply) => {
    const yo = usuarioDe(req);
    const { id } = validar(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { rows } = await db.query<{ grabacion_path: string | null }>(
      'SELECT grabacion_path FROM llamadas WHERE id = $1 AND vendedor_id = $2',
      [id, yo.id],
    );
    if (!rows[0]?.grabacion_path) throw errorHttp(404, 'La llamada no tiene grabación');
    const respuesta = await ari.descargarGrabacion(rows[0].grabacion_path);
    if (!respuesta.ok || !respuesta.body) throw errorHttp(404, 'La grabación ya no está en el servidor');
    reply.type('audio/wav');
    const largo = respuesta.headers.get('content-length');
    if (largo) reply.header('Content-Length', largo);
    return reply.send(Readable.fromWeb(respuesta.body as import('node:stream/web').ReadableStream));
  });
}
