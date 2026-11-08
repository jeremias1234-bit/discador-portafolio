// Campañas: los 5 tipos, sus parámetros, vendedores asignados, gateways y estados (§1, §2, §3).
// Las campañas IVR se gestionan con los permisos 'ivr.*'; las demás con 'campanas.*'.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { registrarEnBitacora } from '../bitacora.js';
import { armarUpdate } from '../db/sql.js';
import { conTransaccion } from '../db/transaccion.js';
import { publicarEvento } from '../eventos.js';
import { momentoEn, motivoFueraDeHorario } from '../telefonia/horario.js';
import { normalizarTelefono } from '../telefonos.js';
import { requierePermiso, usuarioDe, type UsuarioSesion } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

export const TIPOS_CAMPANA = ['manual', 'progresivo', 'predictivo', 'predictivo_audio', 'ivr'] as const;
type TipoCampana = (typeof TIPOS_CAMPANA)[number];
const TIPOS_CON_AUDIO: TipoCampana[] = ['predictivo_audio', 'ivr'];

export const COLUMNAS_CAMPANA = `c.id, c.nombre, c.tipo, c.estado, c.prioridad,
  to_char(c.hora_inicio, 'HH24:MI') AS hora_inicio, to_char(c.hora_fin, 'HH24:MI') AS hora_fin, c.dias_semana,
  c.max_intentos, c.minutos_reintento, c.segundos_timbre, c.todos_los_gateways, c.tope_canales,
  c.llamadas_por_vendedor::float8 AS llamadas_por_vendedor, c.puertos_por_vendedor_auto,
  c.abandono_objetivo_pct::float8 AS abandono_objetivo_pct,
  c.amd_activo, c.grabar, c.audio_id, c.audio_b_id, c.audio_b_pct, c.ivr_modo, c.ivr_tecla_pase, c.ivr_tecla_no_llame, c.ivr_espera_seg,
  c.ivr_repeticiones, c.ivr_destino, c.ivr_tecla_llamada, c.ivr_tecla_whatsapp, c.ivr_audio_despedida_id,
  c.espera_max_seg, c.ivr_canales, c.llamadas_por_segundo::float8 AS llamadas_por_segundo,
  c.creada_por, c.creada_en, c.archivada_en`;

// Avance de la base, contando solo listas activas (§6)
const METRICAS_LEADS = `LEFT JOIN LATERAL (
    SELECT count(*)::int AS leads_total,
           count(*) FILTER (WHERE l.estado = 'pendiente')::int AS leads_sin_llamar,
           count(*) FILTER (WHERE l.estado = 'reintentar')::int AS leads_reintentar,
           count(*) FILTER (WHERE l.estado = 'en_curso')::int AS leads_en_curso,
           count(*) FILTER (WHERE l.estado = 'finalizado')::int AS leads_finalizados,
           count(*) FILTER (WHERE l.estado = 'agotado')::int AS leads_agotados,
           count(*) FILTER (WHERE l.estado = 'no_llamar')::int AS leads_no_llamar
      FROM leads l JOIN listas li ON li.id = l.lista_id AND li.activa
     WHERE l.campana_id = c.id) m ON true`;

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato HH:MM');
const tecla = z.string().regex(/^[0-9*#]$/, 'una tecla: 0-9, * o #');

const camposCampana = {
  nombre: z.string().trim().min(1).max(120),
  tipo: z.enum(TIPOS_CAMPANA),
  prioridad: z.number().int().min(-100).max(100),
  hora_inicio: hora,
  hora_fin: hora,
  dias_semana: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .refine((d) => new Set(d).size === d.length, 'días repetidos'),
  max_intentos: z.number().int().min(1).max(50),
  minutos_reintento: z.number().int().min(1).max(10080),
  segundos_timbre: z.number().int().min(5).max(120),
  todos_los_gateways: z.boolean(),
  tope_canales: z.number().int().positive().max(1000).nullable(),
  llamadas_por_vendedor: z.number().positive().max(20).nullable(),
  puertos_por_vendedor_auto: z.boolean(),
  abandono_objetivo_pct: z.number().min(0).max(100).nullable(),
  amd_activo: z.boolean(),
  grabar: z.boolean(),
  audio_id: z.number().int().positive().nullable(),
  audio_b_id: z.number().int().positive().nullable(),
  audio_b_pct: z.number().int().min(0).max(100),
  ivr_modo: z.enum(['presione_1', 'permanencia', 'cualquiera']),
  ivr_tecla_pase: tecla,
  ivr_tecla_no_llame: tecla.nullable(),
  ivr_espera_seg: z.number().int().min(0).max(120),
  ivr_repeticiones: z.number().int().min(1).max(10),
  ivr_destino: z.enum(['vendedor', 'aviso']),
  ivr_tecla_llamada: tecla.nullable(),
  ivr_tecla_whatsapp: tecla.nullable(),
  ivr_audio_despedida_id: z.number().int().positive().nullable(),
  espera_max_seg: z.number().int().min(0).max(600),
  ivr_canales: z.number().int().positive().max(1000).nullable(),
  llamadas_por_segundo: z.number().positive().max(100).nullable(),
};

const esquemaAlta = z
  .object(camposCampana)
  .partial()
  .required({ nombre: true, tipo: true })
  .strict();

const esquemaEdicion = z
  .object(camposCampana)
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'no hay campos para modificar');

const esquemaId = z.object({ id: z.coerce.number().int().positive() });
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato AAAA-MM-DD');

function permisoEditar(tipo: TipoCampana): string {
  return tipo === 'ivr' ? 'ivr.editar' : 'campanas.editar';
}

function exigir(yo: UsuarioSesion, permiso: string): void {
  if (!yo.permisos.has(permiso)) throw errorHttp(403, 'No tenés permiso para esta acción');
}

function puedeVer(yo: UsuarioSesion, tipo: TipoCampana): boolean {
  return yo.permisos.has(tipo === 'ivr' ? 'ivr.ver' : 'campanas.ver');
}

export async function buscarCampana(
  db: pg.Pool | pg.PoolClient,
  yo: UsuarioSesion,
  id: number,
): Promise<{ id: number; tipo: TipoCampana; estado: string; audio_id: number | null; audio_b_id: number | null; todos_los_gateways: boolean }> {
  const { rows } = await db.query(
    'SELECT id, tipo, estado, audio_id, audio_b_id, todos_los_gateways FROM campanas WHERE id = $1',
    [id],
  );
  const c = rows[0];
  if (!c || !puedeVer(yo, c.tipo)) throw errorHttp(404, 'Campaña no encontrada');
  return c;
}

export function rutasCampanas(app: FastifyInstance, { db, redis, ari, conmutador, motor, configuracion, avisos }: Dependencias): void {
  const verCampanas = requierePermiso('campanas.ver', 'ivr.ver');

  app.get('/api/campanas', { preHandler: verCampanas }, async (req) => {
    const yo = usuarioDe(req);
    const filtro = validar(
      z.object({ incluir_archivadas: z.enum(['true', 'false']).optional(), tipo: z.enum(TIPOS_CAMPANA).optional() }),
      req.query,
    );
    const tiposVisibles = TIPOS_CAMPANA.filter((t) => puedeVer(yo, t) && (!filtro.tipo || t === filtro.tipo));
    const { rows } = await db.query(
      `SELECT ${COLUMNAS_CAMPANA}, m.*,
              (SELECT count(*)::int FROM campana_vendedores cv WHERE cv.campana_id = c.id) AS vendedores
         FROM campanas c ${METRICAS_LEADS}
        WHERE c.tipo = ANY($1) AND ($2 OR c.estado <> 'archivada')
        ORDER BY (c.estado = 'activa') DESC, c.prioridad DESC, c.id DESC`,
      [tiposVisibles, filtro.incluir_archivadas === 'true'],
    );
    return rows;
  });

  app.get('/api/campanas/:id', { preHandler: verCampanas }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    await buscarCampana(db, yo, id);
    const [campana, vendedores, gateways, listas] = await Promise.all([
      db.query(`SELECT ${COLUMNAS_CAMPANA}, m.* FROM campanas c ${METRICAS_LEADS} WHERE c.id = $1`, [id]),
      db.query(
        `SELECT u.id, u.nombre, u.usuario, u.interno_sip, u.activo, u.recibe_ivr
           FROM campana_vendedores cv JOIN usuarios u ON u.id = cv.usuario_id
          WHERE cv.campana_id = $1 ORDER BY u.nombre`,
        [id],
      ),
      db.query(
        `SELECT g.id, g.nombre, g.canales, g.activo FROM campana_gateways cg JOIN gateways g ON g.id = cg.gateway_id
          WHERE cg.campana_id = $1 ORDER BY g.orden`,
        [id],
      ),
      db.query(
        `SELECT id, nombre, activa, cargados, cargada_en FROM listas WHERE campana_id = $1 ORDER BY cargada_en DESC`,
        [id],
      ),
    ]);
    return { ...campana.rows[0], vendedores: vendedores.rows, gateways: gateways.rows, listas: listas.rows };
  });

  app.post('/api/campanas', { preHandler: requierePermiso('campanas.editar', 'ivr.editar') }, async (req, reply) => {
    const yo = usuarioDe(req);
    const datos = validar(esquemaAlta, req.body);
    exigir(yo, permisoEditar(datos.tipo));
    if (datos.audio_b_id && datos.audio_b_id === datos.audio_id) throw errorHttp(400, 'El audio B tiene que ser distinto del A');

    const campos = { ...datos, creada_por: yo.id };
    const columnas = Object.keys(campos);
    const creada = await conTransaccion(db, async (tx) => {
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO campanas (${columnas.join(', ')}) VALUES (${columnas.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING id`,
        Object.values(campos),
      );
      const id = rows[0]!.id;
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'campana.crear', entidad: 'campanas', entidadId: id, detalle: datos, ip: req.ip,
      });
      const { rows: completa } = await tx.query(`SELECT ${COLUMNAS_CAMPANA} FROM campanas c WHERE c.id = $1`, [id]);
      return completa[0];
    });
    await publicarEvento(redis, 'campana.actualizada', { id: creada.id });
    return reply.code(201).send(creada);
  });

  app.patch('/api/campanas/:id', { preHandler: requierePermiso('campanas.editar', 'ivr.editar') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const cambios = validar(esquemaEdicion, req.body);

    const actualizada = await conTransaccion(db, async (tx) => {
      const actual = await buscarCampana(tx, yo, id);
      exigir(yo, permisoEditar(actual.tipo));
      if (cambios.tipo) exigir(yo, permisoEditar(cambios.tipo));
      if (actual.estado === 'archivada') throw errorHttp(400, 'La campaña está archivada: desarchivala para editarla');

      const tipoFinal = cambios.tipo ?? actual.tipo;
      const audioFinal = cambios.audio_id !== undefined ? cambios.audio_id : actual.audio_id;
      if (actual.estado === 'activa' && TIPOS_CON_AUDIO.includes(tipoFinal) && !audioFinal) {
        throw errorHttp(400, 'Una campaña activa de este tipo necesita un audio');
      }
      const audioBFinal = cambios.audio_b_id !== undefined ? cambios.audio_b_id : actual.audio_b_id;
      if (audioBFinal && audioBFinal === audioFinal) throw errorHttp(400, 'El audio B tiene que ser distinto del A');

      const { rows: antes } = await tx.query(`SELECT ${COLUMNAS_CAMPANA} FROM campanas c WHERE c.id = $1`, [id]);
      const { asignaciones, valores } = armarUpdate(cambios);
      await tx.query(`UPDATE campanas SET ${asignaciones} WHERE id = $1`, [id, ...valores]);
      const anterior = antes[0] as Record<string, unknown>;
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'campana.editar', entidad: 'campanas', entidadId: id, ip: req.ip,
        detalle: { antes: Object.fromEntries(Object.keys(cambios).map((c) => [c, anterior[c]])), despues: cambios },
      });
      const { rows } = await tx.query(`SELECT ${COLUMNAS_CAMPANA} FROM campanas c WHERE c.id = $1`, [id]);
      return rows[0];
    });
    await publicarEvento(redis, 'campana.actualizada', { id });
    return actualizada;
  });

  // Checklist "listo para arrancar" (§10): qué falta para que la campaña marque
  app.get('/api/campanas/:id/checklist', { preHandler: verCampanas }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    await buscarCampana(db, yo, id);
    const config = await configuracion.obtener();
    const { rows } = await db.query(
      `SELECT c.id, c.tipo, c.estado, c.amd_activo, c.audio_id, c.audio_b_id, c.audio_b_pct, c.ivr_destino, c.todos_los_gateways, c.dias_semana,
              to_char(c.hora_inicio, 'HH24:MI') AS hora_inicio, to_char(c.hora_fin, 'HH24:MI') AS hora_fin,
              (SELECT count(*)::int FROM leads l JOIN listas li ON li.id = l.lista_id AND li.activa
                WHERE l.campana_id = c.id AND l.estado IN ('pendiente', 'reintentar')) AS contactos,
              (SELECT array_agg(cv.usuario_id) FROM campana_vendedores cv WHERE cv.campana_id = c.id) AS vendedores,
              (SELECT array_agg(cg.gateway_id) FROM campana_gateways cg WHERE cg.campana_id = c.id) AS gateways,
              (SELECT count(*)::int FROM no_llame_padron) AS padron,
              (SELECT EXTRACT(DAY FROM now() - max(terminada_en))::int FROM no_llame_importaciones WHERE estado = 'aplicada') AS dias_padron
         FROM campanas c WHERE c.id = $1`,
      [id],
    );
    const c = rows[0];
    const asignados: number[] = c.vendedores ?? [];
    const conectados = asignados.filter((u) => conmutador.puesto(u)).length;
    const turno = c.ivr_destino === 'aviso' ? await avisos.turno(id) : null;
    const permitidos: number[] | null = c.todos_los_gateways ? null : (c.gateways ?? []);
    const gateways = conmutador.gateways.filter((g) => !permitidos || permitidos.includes(g.id));
    const online = (await Promise.all(gateways.map((g) => ari.estadoEndpoint('PJSIP', g.endpoint).then((e) => e.state, () => '')))).filter((e) => e === 'online').length;
    const fuera = motivoFueraDeHorario(conmutador.reglas, momentoEn(config['general.zona_horaria']), c);
    const decision = motor.decisiones.get(id);
    const necesitaAudio = c.tipo === 'predictivo_audio' || c.tipo === 'ivr';
    const item = (clave: string, ok: boolean, detalle: string, obligatorio = true) => ({ clave, ok, obligatorio, detalle });
    const items = [
      item('base', c.contactos > 0, `${c.contactos} contactos para llamar`),
      turno
        ? item('vendedores', turno.vendedores.length > 0,
          `${turno.vendedores.length} vendedores reciben los avisos por turno (${turno.vendedores.filter((v) => v.conectado).length} conectados ahora)`)
        : item('vendedores', c.tipo === 'ivr' || conectados > 0, `${conectados} de ${asignados.length} vendedores asignados con la línea conectada`, c.tipo !== 'ivr'),
      item('no_llame', c.padron > 0 && (c.dias_padron ?? 999) <= config['no_llame.alerta_dias_padron'],
        c.padron > 0 ? `padrón con ${c.padron} números, cargado hace ${c.dias_padron ?? '?'} días` : 'el padrón No Llame nunca se cargó'),
      item('horario', !fuera, fuera ?? 'dentro del horario'),
      item('amd', true, c.amd_activo ? 'AMD activado' : 'AMD desactivado', false),
      item('gateways', online > 0, `${online} de ${gateways.length} gateways en línea`),
      item('motor', c.tipo === 'manual' || (c.estado === 'activa' && !!decision && Date.now() - decision.ts < 15_000),
        c.estado !== 'activa' ? 'la campaña no está activa' : decision ? `motor: ${decision.motivo}` : 'el motor todavía no la evaluó', c.estado === 'activa'),
      item('audio', !necesitaAudio || !!c.audio_id, !necesitaAudio ? 'no usa audio' : !c.audio_id ? 'falta elegir el audio'
        : c.audio_b_id && c.audio_b_pct > 0 ? `audios A y B: ${100 - c.audio_b_pct} % con el A y ${c.audio_b_pct} % con el B` : 'audio elegido', necesitaAudio),
    ];
    return { listo: items.every((i) => i.ok || !i.obligatorio), items };
  });

  // Encender / pausar / terminar / archivar / desarchivar
  app.post('/api/campanas/:id/estado', { preHandler: verCampanas }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { estado } = validar(
      z.object({ estado: z.enum(['activa', 'pausada', 'terminada', 'archivada']) }).strict(),
      req.body,
    );

    await conTransaccion(db, async (tx) => {
      const c = await buscarCampana(tx, yo, id);
      const archivar = estado === 'archivada' || c.estado === 'archivada';
      exigir(yo, archivar ? 'campanas.archivar' : 'campanas.encender');
      if (c.estado === 'archivada' && estado !== 'pausada') {
        throw errorHttp(400, 'Una campaña archivada solo puede volver a "pausada"');
      }

      if (estado === 'activa') {
        if (TIPOS_CON_AUDIO.includes(c.tipo) && !c.audio_id) throw errorHttp(400, 'Falta elegir el audio de la campaña');
        if (!c.todos_los_gateways) {
          const { rows } = await tx.query(
            `SELECT count(*)::int AS n FROM campana_gateways cg JOIN gateways g ON g.id = cg.gateway_id
              WHERE cg.campana_id = $1 AND g.activo`,
            [id],
          );
          if (!rows[0]?.n) throw errorHttp(400, 'La campaña no tiene ningún gateway activo asignado');
        }
      }

      await tx.query(
        `UPDATE campanas SET estado = $2,
                archivada_en = CASE WHEN $2 = 'archivada' THEN now() WHEN $2 = 'pausada' THEN NULL ELSE archivada_en END
          WHERE id = $1`,
        [id, estado],
      );
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'campana.estado', entidad: 'campanas', entidadId: id, ip: req.ip,
        detalle: { antes: c.estado, despues: estado },
      });
    });
    await publicarEvento(redis, 'campana.actualizada', { id });
    return { ok: true, estado };
  });

  // "Probar llamada" de una campaña IVR con aviso: la llama a un número con el flujo completo
  // (AMD, audio, teclas). No reparte avisos ni cuenta en los reportes de la campaña.
  app.post('/api/campanas/:id/probar-ivr', { preHandler: requierePermiso('ivr.editar') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const datos = validar(z.object({ telefono: z.string().min(1), audio: z.enum(['a', 'b']).optional() }).strict(), req.body);
    const telefono = normalizarTelefono(datos.telefono);
    if (!telefono) throw errorHttp(400, 'Número inválido');
    await buscarCampana(db, yo, id);
    const llamadaId = await conmutador.probarIvr(id, telefono, datos.audio);
    await registrarEnBitacora(db, {
      usuarioId: yo.id, accion: 'campana.probar_ivr', entidad: 'campanas', entidadId: id, ip: req.ip,
      detalle: { telefono, llamada_id: llamadaId, audio: datos.audio ?? 'a' },
    });
    return { ok: true, llamada_id: llamadaId, telefono };
  });

  // Línea de tiempo de una prueba: segundos desde que empezó a marcar
  app.get('/api/ivr/pruebas/:id', { preHandler: requierePermiso('ivr.editar') }, async (req) => {
    const { id } = validar(esquemaId, req.params);
    const { rows } = await db.query(
      `SELECT id, telefono, resultado, amd_estado, tecla_ivr, causa_sip, audio_id, fin IS NOT NULL AS terminada,
              extract(epoch FROM contestada_en - inicio)::float8 AS atendio_seg,
              extract(epoch FROM audio_inicio_en - inicio)::float8 AS audio_inicio_seg,
              extract(epoch FROM audio_fin_en - inicio)::float8 AS audio_fin_seg,
              extract(epoch FROM coalesce(fin, now()) - inicio)::float8 AS duracion_seg
         FROM llamadas WHERE id = $1 AND origen = 'prueba'`,
      [id],
    );
    if (!rows[0]) throw errorHttp(404, 'No se encontró esa prueba');
    return rows[0];
  });

  // Comparación de audios: de los que empezaron a escuchar el mensaje, qué hizo cada audio.
  // Cuenta las llamadas terminadas entre las dos fechas (por defecto, hoy). Las anteriores a la
  // migración 007 no tienen el audio guardado.
  app.get('/api/campanas/:id/audios', { preHandler: verCampanas }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const zona = (await configuracion.obtener())['general.zona_horaria'];
    const hoy = momentoEn(zona).fecha;
    const filtro = validar(z.object({ desde: fecha.optional(), hasta: fecha.optional() }), req.query);
    await buscarCampana(db, yo, id);
    const { rows } = await db.query(
      `SELECT l.audio_id, au.nombre, au.duracion_seg::float8 AS duracion_seg,
              count(*)::int AS escucharon,
              count(*) FILTER (WHERE l.resultado = 'corto_en_mensaje')::int AS cortaron,
              count(*) FILTER (WHERE l.audio_fin_en IS NOT NULL)::int AS llegaron_al_final,
              count(*) FILTER (WHERE l.resultado = 'aviso_ivr')::int AS marcaron,
              count(*) FILTER (WHERE av.contacto = 'llamada')::int AS llamada,
              count(*) FILTER (WHERE av.contacto = 'whatsapp')::int AS whatsapp,
              count(*) FILTER (WHERE l.resultado = 'sin_confirmar')::int AS sin_marcar,
              count(*) FILTER (WHERE l.resultado = 'no_llame_ivr')::int AS no_llame,
              round(avg(extract(epoch FROM l.fin - l.audio_inicio_en)) FILTER (WHERE l.resultado = 'corto_en_mensaje'), 1)::float8 AS seg_hasta_cortar
         FROM llamadas l
         LEFT JOIN audios au ON au.id = l.audio_id
         LEFT JOIN avisos_ivr av ON av.llamada_id = l.id
        WHERE l.campana_id = $1 AND l.audio_id IS NOT NULL AND l.fin IS NOT NULL
          AND l.inicio >= ($2::date::timestamp AT TIME ZONE $4) AND l.inicio < (($3::date + 1)::timestamp AT TIME ZONE $4)
        GROUP BY l.audio_id, au.nombre, au.duracion_seg
        ORDER BY l.audio_id`,
      [id, filtro.desde ?? hoy, filtro.hasta ?? hoy, zona],
    );
    return rows;
  });

  // Reemplaza los vendedores asignados (el cambio se aplica en segundos, sin cortar llamadas)
  app.put('/api/campanas/:id/vendedores', { preHandler: requierePermiso('vendedores.asignar') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { usuarios } = validar(
      z.object({ usuarios: z.array(z.number().int().positive()).max(500) }).strict(),
      req.body,
    );
    const ids = [...new Set(usuarios)];

    await conTransaccion(db, async (tx) => {
      await buscarCampana(tx, yo, id);
      const { rows } = await tx.query<{ id: number }>(
        "SELECT id FROM usuarios WHERE id = ANY($1) AND rol = 'vendedor' AND activo",
        [ids],
      );
      if (rows.length !== ids.length) {
        const validos = new Set(rows.map((r) => r.id));
        throw errorHttp(400, `No son vendedores activos: ${ids.filter((i) => !validos.has(i)).join(', ')}`);
      }
      const { rows: antes } = await tx.query<{ usuario_id: number }>(
        'SELECT usuario_id FROM campana_vendedores WHERE campana_id = $1 ORDER BY usuario_id',
        [id],
      );
      await tx.query('DELETE FROM campana_vendedores WHERE campana_id = $1', [id]);
      await tx.query(
        'INSERT INTO campana_vendedores (campana_id, usuario_id) SELECT $1, unnest($2::int[])',
        [id, ids],
      );
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'campana.vendedores', entidad: 'campanas', entidadId: id, ip: req.ip,
        detalle: { antes: antes.map((r) => r.usuario_id), despues: ids.sort((a, b) => a - b) },
      });
    });
    await publicarEvento(redis, 'campana.actualizada', { id });
    return { ok: true, usuarios: ids };
  });

  // Reemplaza los gateways permitidos (se usan cuando todos_los_gateways = false)
  app.put('/api/campanas/:id/gateways', { preHandler: requierePermiso('campanas.editar', 'ivr.editar') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { gateways } = validar(
      z.object({ gateways: z.array(z.number().int().positive()).max(100) }).strict(),
      req.body,
    );
    const ids = [...new Set(gateways)];

    await conTransaccion(db, async (tx) => {
      const c = await buscarCampana(tx, yo, id);
      exigir(yo, permisoEditar(c.tipo));
      const { rows } = await tx.query('SELECT id FROM gateways WHERE id = ANY($1)', [ids]);
      if (rows.length !== ids.length) throw errorHttp(400, 'Algún gateway indicado no existe');
      await tx.query('DELETE FROM campana_gateways WHERE campana_id = $1', [id]);
      await tx.query('INSERT INTO campana_gateways (campana_id, gateway_id) SELECT $1, unnest($2::int[])', [id, ids]);
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'campana.gateways', entidad: 'campanas', entidadId: id, ip: req.ip,
        detalle: { gateways: ids },
      });
    });
    await publicarEvento(redis, 'campana.actualizada', { id });
    return { ok: true, gateways: ids };
  });
}
