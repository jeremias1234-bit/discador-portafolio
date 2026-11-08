// Monitor en vivo (§10), supervisión (escuchar / susurrar / intervenir) y WebSocket.
//   WS /api/ws: cada usuario recibe los eventos de su puesto; quien tiene 'monitor.ver'
//   recibe además una instantánea del monitor por segundo.
//   Avisos del IVR (canal 'avisos'): el nuevo le llega a su vendedor; quien tiene 'ivr.avisos'
//   recibe un aviso de que hubo cambios. La extensión de Chrome se autentica con el primer
//   mensaje ({ token }), porque un WebSocket del navegador no puede mandar cabeceras.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Aviso } from '../avisos.js';
import type { UsuarioSesion } from './autenticacion.js';
import { z } from 'zod';
import { registrarEnBitacora } from '../bitacora.js';
import { requierePermiso, usuarioDe } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const INTERVALO_MONITOR_MS = 1000;
const INTERVALO_LENTO_MS = 10_000;

export function rutasTiempoReal(app: FastifyInstance, deps: Dependencias): void {
  const { db, ari, conmutador, motor, configuracion, avisos } = deps;
  const conexiones = new Map<number, Set<WebSocket>>();
  const conMonitor = new Set<WebSocket>();
  const conAvisos = new Set<WebSocket>(); // ven los avisos de todos

  // Datos que no hace falta recalcular cada segundo
  let lento: {
    kpis: unknown; estado_gateways: Record<number, string>; contestacion_gateways: unknown[]; alertas: string[];
    espera_hoy: Record<number, { promedio_seg: number | null; atendidas: number }>;
  } = { kpis: null, estado_gateways: {}, contestacion_gateways: [], alertas: [], espera_hoy: {} };

  async function calcularLento(): Promise<void> {
    const config = await configuracion.obtener();
    const [kpis, contestacion, campanas, padron, espera] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS intentos,
                count(*) FILTER (WHERE contestada_en IS NOT NULL)::int AS atendidas,
                count(*) FILTER (WHERE contestada_en IS NOT NULL AND resultado IS DISTINCT FROM 'contestador')::int AS personas,
                count(*) FILTER (WHERE conectada_vendedor_en IS NOT NULL)::int AS llegaron_al_vendedor,
                count(*) FILTER (WHERE resultado = 'abandonada')::int AS abandonos,
                count(*) FILTER (WHERE resultado = 'contestador')::int AS contestadores
           FROM llamadas WHERE inicio > now() - interval '15 minutes'`,
      ),
      db.query(
        `SELECT gateway_id, count(*)::int AS intentos,
                round(100.0 * count(*) FILTER (WHERE contestada_en IS NOT NULL) / greatest(count(*), 1), 1)::float8 AS contestacion_pct
           FROM llamadas WHERE inicio >= date_trunc('day', now()) AND gateway_id IS NOT NULL GROUP BY gateway_id`,
      ),
      db.query<{ id: number; nombre: string; asignados: number; restantes: number }>(
        `SELECT c.id, c.nombre,
                (SELECT count(*)::int FROM campana_vendedores cv WHERE cv.campana_id = c.id) AS asignados,
                (SELECT count(*)::int FROM leads l JOIN listas li ON li.id = l.lista_id AND li.activa
                  WHERE l.campana_id = c.id AND l.estado IN ('pendiente', 'reintentar')) AS restantes
           FROM campanas c WHERE c.estado = 'activa'`,
      ),
      db.query<{ dias: number | null }>(
        "SELECT EXTRACT(DAY FROM now() - max(terminada_en))::int AS dias FROM no_llame_importaciones WHERE estado = 'aplicada'",
      ),
      // Espera promedio entre llamadas de hoy: tiempo disponible / llamadas que le llegaron
      db.query<{ usuario_id: number; promedio_seg: number | null; atendidas: number }>(
        `WITH hoy AS (SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS ini),
         disp AS (
           SELECT e.usuario_id, sum(EXTRACT(EPOCH FROM (coalesce(e.siguiente, now()) - greatest(e.ts, hoy.ini))))::int AS seg
             FROM (SELECT usuario_id, estado, ts, lead(ts) OVER (PARTITION BY usuario_id ORDER BY ts, id) AS siguiente
                     FROM vendedor_eventos, hoy WHERE ts >= hoy.ini - interval '1 day') e, hoy
            WHERE e.estado = 'disponible' AND coalesce(e.siguiente, now()) > hoy.ini
            GROUP BY e.usuario_id
         ), llam AS (
           SELECT vendedor_id, count(*)::int AS n FROM llamadas, hoy
            WHERE inicio >= hoy.ini AND conectada_vendedor_en IS NOT NULL AND vendedor_id IS NOT NULL GROUP BY vendedor_id
         )
         SELECT d.usuario_id, round(d.seg::numeric / nullif(l.n, 0))::int AS promedio_seg, coalesce(l.n, 0) AS atendidas
           FROM disp d LEFT JOIN llam l ON l.vendedor_id = d.usuario_id`,
        [config['general.zona_horaria']],
      ),
    ]);

    const estado: Record<number, string> = {};
    await Promise.all(
      conmutador.gateways.map(async (g) => {
        estado[g.id] = await ari.estadoEndpoint('PJSIP', g.endpoint).then((e) => e.state, () => 'desconocido');
      }),
    );

    const alertas: string[] = [];
    const conectados = conmutador.instantanea().puestos;
    for (const c of campanas.rows) {
      const libres = conmutador.libresPara({ id: c.id, tipo: 'progresivo' }).length;
      const enLinea = conectados.filter((p) => conmutador.asignaciones.get(c.id)?.has(p.usuario_id)).length;
      if (enLinea === 0 && libres === 0) alertas.push(`Campaña "${c.nombre}" activa sin vendedores conectados`);
      if (c.restantes <= config['ritmo.aviso_base_por_acabarse']) alertas.push(`Campaña "${c.nombre}": quedan ${c.restantes} contactos`);
    }
    for (const g of conmutador.gateways) if (estado[g.id] !== 'online') alertas.push(`Gateway ${g.nombre} ${estado[g.id]}`);
    const largaSeg = config['ritmo.aviso_llamada_larga_min'] * 60;
    for (const l of conmutador.instantanea().llamadas) {
      if (l.fase === 'conversacion' && l.segundos > largaSeg) alertas.push(`Llamada larga: ${l.telefono} (${Math.round(l.segundos / 60)} min)`);
    }
    const recientes = conmutador.vigilancia.eventos.filter((e) => Date.now() - e.ts < 10 * 60_000).length;
    if (recientes > 0) alertas.push(`El vigilante cortó ${recientes} llamada(s) o canal(es) trabados en los últimos 10 minutos`);
    const dias = padron.rows[0]?.dias;
    if (dias === null || dias === undefined || dias > config['no_llame.alerta_dias_padron']) {
      alertas.push(dias == null ? 'El padrón No Llame nunca se cargó' : `El padrón No Llame tiene ${dias} días`);
    }
    const esperaHoy = Object.fromEntries(espera.rows.map((r) => [r.usuario_id, { promedio_seg: r.promedio_seg, atendidas: r.atendidas }]));
    lento = { kpis: kpis.rows[0], estado_gateways: estado, contestacion_gateways: contestacion.rows, alertas, espera_hoy: esperaHoy };
  }

  function monitor() {
    const inst = conmutador.instantanea();
    const contestacion = new Map((lento.contestacion_gateways as { gateway_id: number }[]).map((c) => [c.gateway_id, c]));
    return {
      ...inst,
      gateways: inst.gateways.map((g) => ({
        ...g, estado: lento.estado_gateways[g.id] ?? 'desconocido', hoy: contestacion.get(g.id) ?? null,
      })),
      decisiones: [...motor.decisiones.values()],
      espera_hoy: lento.espera_hoy,
      vigilancia: conmutador.vigilancia,
      espera_objetivo: {
        min_seg: conmutador.config?.['ritmo.espera_objetivo_min_seg'] ?? 5,
        max_seg: conmutador.config?.['ritmo.espera_objetivo_max_seg'] ?? 60,
      },
      kpis_15_min: lento.kpis,
      alertas: lento.alertas,
    };
  }

  const enviar = (ws: WebSocket, mensaje: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(mensaje));
  };

  conmutador.on('puesto', (usuarioId: number, mensaje: unknown) => {
    for (const ws of conexiones.get(usuarioId) ?? []) enviar(ws, { canal: 'puesto', ...(mensaje as object) });
  });

  const avisarCambioAvisos = (aviso: Aviso | null) => {
    for (const ws of conAvisos) enviar(ws, { canal: 'avisos', tipo: 'cambio', aviso_id: aviso?.id ?? null });
  };
  avisos.on('nuevo', (aviso: Aviso) => {
    if (aviso.vendedor_id) for (const ws of conexiones.get(aviso.vendedor_id) ?? []) enviar(ws, { canal: 'avisos', tipo: 'nuevo', aviso });
    avisarCambioAvisos(aviso);
  });
  avisos.on('cambio', avisarCambioAvisos);

  const tLento = setInterval(() => void calcularLento().catch((err: unknown) => app.log.error({ err }, 'Error calculando el monitor')), INTERVALO_LENTO_MS);
  const tMonitor = setInterval(() => {
    if (conMonitor.size === 0) return;
    const datos = { canal: 'monitor', ...monitor() };
    for (const ws of conMonitor) enviar(ws, datos);
  }, INTERVALO_MONITOR_MS);
  app.addHook('onClose', async () => {
    clearInterval(tLento);
    clearInterval(tMonitor);
  });
  void calcularLento().catch(() => {});

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const registrar = (yo: UsuarioSesion, extension: boolean) => {
      if (!conexiones.has(yo.id)) conexiones.set(yo.id, new Set());
      conexiones.get(yo.id)!.add(socket);
      avisos.conectar(yo.id);
      // La extensión solo quiere avisos: el monitor por segundo sería tráfico de más
      if (yo.permisos.has('monitor.ver') && !extension) conMonitor.add(socket);
      if (yo.permisos.has('ivr.avisos')) conAvisos.add(socket);
      const p = conmutador.puesto(yo.id);
      enviar(socket, { canal: 'puesto', tipo: 'hola', linea_conectada: !!p, estado: p?.estado ?? null, nombre: yo.nombre });
      socket.on('close', () => {
        conexiones.get(yo.id)?.delete(socket);
        conMonitor.delete(socket);
        conAvisos.delete(socket);
        avisos.desconectar(yo.id);
      });
    };

    if (req.usuario) return registrar(req.usuario, false);
    // Sin cookie: la extensión manda { token } como primer mensaje
    const plazo = setTimeout(() => socket.close(4401, 'Sesión requerida'), 5000);
    socket.once('message', (datos) => {
      clearTimeout(plazo);
      let token = '';
      try {
        token = String((JSON.parse(String(datos)) as { token?: unknown }).token ?? '');
      } catch { /* mensaje inválido: se cierra abajo */ }
      void (token ? app.usuarioDeToken(token) : Promise.resolve(null)).then((yo) => {
        if (!yo) socket.close(4401, 'Sesión requerida');
        else registrar(yo, true);
      });
    });
  });

  app.get('/api/monitor', { preHandler: requierePermiso('monitor.ver') }, async () => monitor());

  // --- Supervisión ---

  const PERMISO_MODO = { escuchar: 'supervision.escuchar', susurrar: 'supervision.susurrar', intervenir: 'supervision.intervenir' } as const;

  app.post('/api/supervision/escuchar', { preHandler: requierePermiso(...Object.values(PERMISO_MODO)) }, async (req) => {
    const yo = usuarioDe(req);
    const { vendedor_id, modo } = validar(
      z.object({ vendedor_id: z.number().int().positive(), modo: z.enum(['escuchar', 'susurrar', 'intervenir']) }).strict(),
      req.body,
    );
    if (!yo.permisos.has(PERMISO_MODO[modo])) throw errorHttp(403, `No tenés permiso para ${modo}`);
    await conmutador.escuchar(yo.id, vendedor_id, modo);
    await registrarEnBitacora(db, {
      usuarioId: yo.id, accion: `supervision.${modo}`, entidad: 'usuarios', entidadId: vendedor_id, ip: req.ip,
    });
    return { ok: true };
  });

  app.post('/api/supervision/dejar', { preHandler: requierePermiso(...Object.values(PERMISO_MODO)) }, async (req) => {
    await conmutador.dejarDeEscuchar(usuarioDe(req).id);
    return { ok: true };
  });
}
