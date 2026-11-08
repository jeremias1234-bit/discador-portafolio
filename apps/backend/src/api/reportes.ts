// Reportes (§12) y derivaciones del IVR. Todos aceptan ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
// (fechas en la zona horaria configurada; por defecto, hoy) y ?formato=csv para exportar.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registrarEnBitacora } from '../bitacora.js';
import { momentoEn } from '../telefonia/horario.js';
import { requierePermiso, usuarioDe } from './autenticacion.js';
import { enviarCsv } from './csv.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato AAAA-MM-DD');
const esquemaFiltro = z.object({
  desde: fecha.optional(),
  hasta: fecha.optional(),
  campana_id: z.coerce.number().int().positive().optional(),
  vendedor_id: z.coerce.number().int().positive().optional(),
  formato: z.enum(['json', 'csv']).default('json'),
});

// Rango [desde 00:00, hasta+1 00:00) en la zona configurada ($1, $2, $3) y filtros opcionales ($4, $5)
const RANGO = `l.inicio >= ($1::date)::timestamp AT TIME ZONE $3
           AND l.inicio < ($2::date + 1)::timestamp AT TIME ZONE $3
           AND ($4::int IS NULL OR l.campana_id = $4)
           AND ($5::int IS NULL OR l.vendedor_id = $5)`;

// Métricas comunes sobre `llamadas l` (con `tipificaciones t` unida)
const METRICAS = `count(*)::int AS intentos,
  count(*) FILTER (WHERE l.contestada_en IS NOT NULL)::int AS atendidas,
  count(*) FILTER (WHERE l.contestada_en IS NOT NULL AND l.resultado IS DISTINCT FROM 'contestador')::int AS personas,
  count(*) FILTER (WHERE l.resultado = 'contestador')::int AS contestadores,
  count(*) FILTER (WHERE l.conectada_vendedor_en IS NOT NULL)::int AS llegaron_al_vendedor,
  count(*) FILTER (WHERE l.resultado = 'abandonada')::int AS abandonos,
  round(100.0 * count(*) FILTER (WHERE l.resultado = 'abandonada')
        / nullif(count(*) FILTER (WHERE l.resultado = 'abandonada' OR l.conectada_vendedor_en IS NOT NULL), 0), 1)::float8 AS abandono_pct,
  round(100.0 * count(*) FILTER (WHERE l.contestada_en IS NOT NULL AND l.resultado IS DISTINCT FROM 'contestador')
        / nullif(count(*), 0), 1)::float8 AS contactabilidad_pct,
  count(*) FILTER (WHERE t.es_venta)::int AS ventas,
  round(avg(EXTRACT(EPOCH FROM (l.fin - l.conectada_vendedor_en))) FILTER (WHERE l.conectada_vendedor_en IS NOT NULL))::int AS conversacion_promedio_seg`;

export function rutasReportes(app: FastifyInstance, { db, configuracion }: Dependencias): void {
  /** Valida filtros, resuelve fechas por defecto y responde JSON o CSV. */
  function reporte(
    ruta: string,
    nombre: string,
    sql: string,
    extra?: (f: z.infer<typeof esquemaFiltro>) => unknown[],
  ): void {
    app.get(ruta, { preHandler: requierePermiso('reportes.ver') }, async (req: FastifyRequest, reply: FastifyReply) => {
      const yo = usuarioDe(req);
      const f = validar(esquemaFiltro.passthrough(), req.query);
      const zona = (await configuracion.obtener())['general.zona_horaria'];
      const hoy = momentoEn(zona).fecha;
      const desde = f.desde ?? hoy;
      const hasta = f.hasta ?? desde;
      if (hasta < desde) throw errorHttp(400, '"hasta" no puede ser anterior a "desde"');
      const { rows } = await db.query(sql, [desde, hasta, zona, f.campana_id ?? null, f.vendedor_id ?? null, ...(extra?.(f) ?? [])]);
      if (f.formato === 'csv') {
        if (!yo.permisos.has('reportes.exportar')) throw errorHttp(403, 'No tenés permiso para exportar');
        await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'reporte.exportar', detalle: { reporte: nombre, desde, hasta }, ip: req.ip });
        return enviarCsv(reply, `${nombre}_${desde}_${hasta}`, rows);
      }
      return rows;
    });
  }

  // Embudo del período: intentos → atendieron → personas → llegaron al vendedor → abandonos
  reporte('/api/reportes/resumen', 'resumen',
    `SELECT ${METRICAS} FROM llamadas l LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id WHERE ${RANGO}`);

  reporte('/api/reportes/horas', 'por_hora',
    `SELECT EXTRACT(HOUR FROM l.inicio AT TIME ZONE $3)::int AS hora, ${METRICAS}
       FROM llamadas l LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id WHERE ${RANGO}
      GROUP BY 1 ORDER BY 1`);

  reporte('/api/reportes/campanas', 'por_campana',
    `SELECT l.campana_id, c.nombre AS campana, c.tipo, ${METRICAS}
       FROM llamadas l LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id LEFT JOIN campanas c ON c.id = l.campana_id
      WHERE ${RANGO} GROUP BY l.campana_id, c.nombre, c.tipo ORDER BY intentos DESC`);

  // Qué bases convierten en ventas (§12, por base u origen)
  reporte('/api/reportes/listas', 'por_base',
    `SELECT l.lista_id, li.nombre AS lista, c.nombre AS campana, ${METRICAS},
            round(100.0 * count(*) FILTER (WHERE t.es_venta)
                  / nullif(count(*) FILTER (WHERE l.conectada_vendedor_en IS NOT NULL), 0), 1)::float8 AS conversion_pct
       FROM llamadas l LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id
       LEFT JOIN listas li ON li.id = l.lista_id LEFT JOIN campanas c ON c.id = li.campana_id
      WHERE ${RANGO} AND l.lista_id IS NOT NULL GROUP BY l.lista_id, li.nombre, c.nombre ORDER BY ventas DESC, intentos DESC`);

  // Por vendedor: llamadas, ventas, tiempos por estado y espera promedio entre llamadas
  reporte('/api/reportes/vendedores', 'por_vendedor',
    `WITH rango AS (
       SELECT ($1::date)::timestamp AT TIME ZONE $3 AS ini, ($2::date + 1)::timestamp AT TIME ZONE $3 AS fin
     ), tiempos AS (
       SELECT e.usuario_id, e.estado,
              sum(EXTRACT(EPOCH FROM (least(coalesce(e.siguiente, now()), r.fin) - greatest(e.ts, r.ini))))::int AS seg
         FROM (SELECT usuario_id, estado, ts, lead(ts) OVER (PARTITION BY usuario_id ORDER BY ts, id) AS siguiente
                 FROM vendedor_eventos, rango WHERE ts < rango.fin AND ts >= rango.ini - interval '1 day') e, rango r
        WHERE e.estado NOT IN ('login', 'logout') AND coalesce(e.siguiente, now()) > r.ini
        GROUP BY e.usuario_id, e.estado
     ), llam AS (
       SELECT l.vendedor_id,
              count(*) FILTER (WHERE l.conectada_vendedor_en IS NOT NULL)::int AS atendidas,
              count(*) FILTER (WHERE l.tipificacion_id IS NOT NULL)::int AS tipificadas,
              count(*) FILTER (WHERE t.es_venta)::int AS ventas,
              count(*) FILTER (WHERE l.origen = 'manual')::int AS manuales,
              round(avg(EXTRACT(EPOCH FROM (l.fin - l.conectada_vendedor_en))) FILTER (WHERE l.conectada_vendedor_en IS NOT NULL))::int AS conversacion_promedio_seg
         FROM llamadas l LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id
        WHERE ${RANGO} AND l.vendedor_id IS NOT NULL GROUP BY l.vendedor_id
     )
     SELECT u.id AS vendedor_id, u.nombre, u.interno_sip,
            coalesce(llam.atendidas, 0) AS atendidas, coalesce(llam.tipificadas, 0) AS tipificadas,
            coalesce(llam.ventas, 0) AS ventas, coalesce(llam.manuales, 0) AS manuales,
            round(100.0 * coalesce(llam.ventas, 0) / nullif(llam.atendidas, 0), 1)::float8 AS conversion_pct,
            llam.conversacion_promedio_seg,
            coalesce(sum(ti.seg) FILTER (WHERE ti.estado = 'disponible'), 0)::int AS seg_disponible,
            coalesce(sum(ti.seg) FILTER (WHERE ti.estado = 'en_llamada'), 0)::int AS seg_en_llamada,
            coalesce(sum(ti.seg) FILTER (WHERE ti.estado = 'tipificando'), 0)::int AS seg_tipificando,
            coalesce(sum(ti.seg) FILTER (WHERE ti.estado = 'descanso'), 0)::int AS seg_descanso,
            round(coalesce(sum(ti.seg) FILTER (WHERE ti.estado = 'disponible'), 0) / nullif(llam.atendidas, 0))::int AS espera_entre_llamadas_seg
       FROM usuarios u
       LEFT JOIN llam ON llam.vendedor_id = u.id
       LEFT JOIN tiempos ti ON ti.usuario_id = u.id
      WHERE u.rol = 'vendedor' AND ($5::int IS NULL OR u.id = $5) AND (llam.vendedor_id IS NOT NULL OR ti.usuario_id IS NOT NULL)
      GROUP BY u.id, u.nombre, u.interno_sip, llam.atendidas, llam.tipificadas, llam.ventas, llam.manuales, llam.conversacion_promedio_seg
      ORDER BY ventas DESC, atendidas DESC`);

  // Descansos por vendedor y motivo
  reporte('/api/reportes/descansos', 'descansos',
    `WITH rango AS (SELECT ($1::date)::timestamp AT TIME ZONE $3 AS ini, ($2::date + 1)::timestamp AT TIME ZONE $3 AS fin)
     SELECT u.nombre AS vendedor, m.nombre AS motivo, count(*)::int AS veces,
            sum(EXTRACT(EPOCH FROM (least(coalesce(e.siguiente, now()), r.fin) - e.ts)))::int AS seg_total
       FROM (SELECT usuario_id, estado, motivo_descanso_id, ts, lead(ts) OVER (PARTITION BY usuario_id ORDER BY ts, id) AS siguiente
               FROM vendedor_eventos) e
       JOIN rango r ON e.ts >= r.ini AND e.ts < r.fin
       JOIN usuarios u ON u.id = e.usuario_id JOIN motivos_descanso m ON m.id = e.motivo_descanso_id
      WHERE e.estado = 'descanso' AND ($5::int IS NULL OR u.id = $5)
        AND ($4::int IS NULL OR $4::int > 0) -- los descansos no son por campaña: el filtro no aplica
      GROUP BY u.nombre, m.nombre ORDER BY u.nombre, seg_total DESC`);

  // AMD: por resultado y por causa. Si dominan LONGGREETING o MAXWORDS, está cortando personas (§5)
  reporte('/api/reportes/amd', 'amd',
    `SELECT coalesce(l.amd_estado, 'sin AMD') AS amd_estado, coalesce(split_part(l.amd_causa, '-', 1), '') AS causa,
            count(*)::int AS llamadas,
            round(100.0 * count(*) / sum(count(*)) OVER (), 1)::float8 AS pct
       FROM llamadas l WHERE ${RANGO} AND l.contestada_en IS NOT NULL
      GROUP BY 1, 2 ORDER BY llamadas DESC`);

  // Contactabilidad: resultado técnico y tipificación
  reporte('/api/reportes/resultados', 'resultados',
    `SELECT coalesce(l.resultado, 'en curso') AS resultado, t.nombre AS tipificacion, count(*)::int AS llamadas,
            round(100.0 * count(*) / sum(count(*)) OVER (), 1)::float8 AS pct
       FROM llamadas l LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id WHERE ${RANGO}
      GROUP BY 1, 2 ORDER BY llamadas DESC`);

  reporte('/api/reportes/derivaciones', 'derivaciones',
    `SELECT d.motivo, d.estado, count(*)::int AS cantidad
       FROM derivaciones d JOIN llamadas l ON l.id = d.llamada_id WHERE ${RANGO}
      GROUP BY 1, 2 ORDER BY cantidad DESC`);

  // Detalle de llamadas (paginado; en CSV sale completo hasta el límite)
  reporte('/api/reportes/llamadas', 'llamadas',
    `SELECT l.id, to_char(l.inicio AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI:SS') AS inicio, l.telefono, l.origen, c.nombre AS campana,
            li.nombre AS lista, g.nombre AS gateway, u.nombre AS vendedor, l.resultado, l.amd_estado, l.amd_causa,
            l.tecla_ivr, t.nombre AS tipificacion, t.es_venta,
            EXTRACT(EPOCH FROM (l.fin - l.inicio))::int AS duracion_total_seg,
            EXTRACT(EPOCH FROM (l.fin - l.conectada_vendedor_en))::int AS conversacion_seg,
            l.colgo, l.notas, (l.grabacion_path IS NOT NULL) AS tiene_grabacion
       FROM llamadas l
       LEFT JOIN campanas c ON c.id = l.campana_id LEFT JOIN listas li ON li.id = l.lista_id
       LEFT JOIN gateways g ON g.id = l.gateway_id LEFT JOIN usuarios u ON u.id = l.vendedor_id
       LEFT JOIN tipificaciones t ON t.id = l.tipificacion_id
      WHERE ${RANGO} AND ($6::text IS NULL OR l.resultado = $6)
      ORDER BY l.id DESC LIMIT $7 OFFSET $8`,
    (f) => {
      const extra = f as Record<string, unknown>;
      const limite = Math.min(Number(extra.limite ?? (f.formato === 'csv' ? 100_000 : 100)) || 100, 100_000);
      return [extra.resultado ?? null, limite, Number(extra.desde_fila ?? 0) || 0];
    });

  // --- Derivaciones del IVR: quien pasó el filtro y nadie atendió, para volver a llamarlo ---

  app.get('/api/derivaciones', { preHandler: requierePermiso('ivr.ver') }, async (req) => {
    const { estado } = validar(z.object({ estado: z.enum(['pendiente', 'atendida', 'descartada']).default('pendiente') }), req.query);
    const { rows } = await db.query(
      `SELECT d.id, d.telefono, d.motivo, d.estado, d.creada_en, d.atendida_en, d.campana_id, c.nombre AS campana,
              d.lead_id, ld.nombre AS lead_nombre, u.nombre AS atendida_por
         FROM derivaciones d LEFT JOIN campanas c ON c.id = d.campana_id
         LEFT JOIN leads ld ON ld.id = d.lead_id LEFT JOIN usuarios u ON u.id = d.atendida_por
        WHERE d.estado = $1 ORDER BY d.creada_en DESC LIMIT 500`,
      [estado],
    );
    return rows;
  });

  app.post('/api/derivaciones/:id/:accion', { preHandler: requierePermiso('ivr.ver') }, async (req) => {
    const yo = usuarioDe(req);
    const { id, accion } = validar(
      z.object({ id: z.coerce.number().int().positive(), accion: z.enum(['atender', 'descartar']) }),
      req.params,
    );
    const { rowCount } = await db.query(
      `UPDATE derivaciones SET estado = $2, atendida_por = $3, atendida_en = now() WHERE id = $1 AND estado = 'pendiente'`,
      [id, accion === 'atender' ? 'atendida' : 'descartada', yo.id],
    );
    if (!rowCount) throw errorHttp(404, 'Derivación no encontrada o ya resuelta');
    return { ok: true };
  });
}
