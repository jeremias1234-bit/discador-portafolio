// Leads del bot de WhatsApp (sección Leads del panel y el Detector de la PC del bot).
//   Detector (token de servicio con alcance 'leads', cabecera Authorization: Bearer svc_...):
//     POST /api/leads                 carga un lead; el mismo número dentro de la ventana de
//                                     deduplicación completa el existente en lugar de crear otro
//     POST /api/leads/latido          "sigo vivo" cada minuto: el panel muestra si el Detector anda
//     GET  /api/leads/config          textos disparadores y tiempos (se editan desde el panel)
//   Panel:
//     GET  /api/leads                 leads con filtros (permiso 'leads.ver')
//     GET  /api/leads/resumen         números del día, turno y estado de los Detectores
//     GET/POST/PATCH/DELETE /api/leads/reglas   reglas de reparto por día y horario (quién recibe)
//     GET/POST/DELETE /api/leads/tokens   tokens del Detector (permiso 'leads.editar')
//   El vendedor ve y cierra sus leads con las mismas rutas de /api/avisos (mios, esperar, estado).
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { COLUMNAS_AVISO, JOIN_AVISO, type Aviso, type DatosLead } from '../avisos.js';
import { registrarEnBitacora } from '../bitacora.js';
import { conTransaccion } from '../db/transaccion.js';
import { extraerDni, normalizarTelefono } from '../telefonos.js';
import { requierePermiso, usuarioDe } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const PREFIJO_TOKEN = 'svc_';
const LATIDO_VIGENTE_MS = 3 * 60_000;
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato AAAA-MM-DD');
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const textoOpcional = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export function rutasLeads(app: FastifyInstance, { db, avisos, configuracion }: Dependencias): void {
  /** Guarda de las rutas del Detector: token de servicio vigente con alcance 'leads'. */
  async function requiereTokenLeads(req: FastifyRequest): Promise<void> {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token?.startsWith(PREFIJO_TOKEN)) throw errorHttp(401, 'Token del Detector requerido');
    const { rows } = await db.query<{ id: number }>(
      `UPDATE tokens_servicio SET ultimo_uso_en = now(), ultimo_ip = $2
        WHERE hash = $1 AND alcance = 'leads' AND revocado_en IS NULL RETURNING id`,
      [hashToken(token), req.ip],
    );
    if (!rows[0]) throw errorHttp(401, 'Token del Detector inválido o revocado');
  }

  const esquemaLead = z.object({
    telefono: z.string().trim().min(6).max(40),
    nombre: textoOpcional(120),
    dni: textoOpcional(40),
    dni_texto: textoOpcional(500),
    compania: textoOpcional(40),
    interes: z.enum(['portabilidad', 'fibra']).nullish().transform((v) => v ?? null),
    direccion: textoOpcional(1000),
    chat_hora: z.string().datetime({ offset: true }).nullish().transform((v) => v ?? null),
    pc_bot: textoOpcional(80),
    prueba: z.boolean().optional(),
  });

  app.post('/api/leads', { preHandler: requiereTokenLeads }, async (req, reply) => {
    const b = validar(esquemaLead, req.body);
    // "Probar envío" de la extensión: confirma token y conexión sin crear nada
    if (b.prueba) return { ok: true, prueba: true };
    const telefono = normalizarTelefono(b.telefono);
    if (!telefono) throw errorHttp(400, `Teléfono inválido: ${b.telefono}`);
    const datos: DatosLead = {
      telefono,
      nombre: b.nombre,
      dni: extraerDni(b.dni) ?? extraerDni(b.dni_texto),
      dni_texto: b.dni_texto,
      compania: b.compania,
      interes: b.interes,
      direccion: b.direccion,
      chat_hora: b.chat_hora,
      pc_bot: b.pc_bot,
    };
    const c = await configuracion.obtener();
    const { aviso, nuevo } = await avisos.registrarLead(datos, c['leads.horas_deduplicacion'], c['general.zona_horaria']);
    return reply.code(nuevo ? 201 : 200).send({ id: aviso.id, nuevo, vendedor: aviso.vendedor });
  });

  app.post('/api/leads/latido', { preHandler: requiereTokenLeads }, async (req) => {
    const b = validar(
      z.object({
        pc_bot: z.string().trim().min(1).max(80),
        version: z.string().trim().max(40).nullish().transform((v) => v ?? null),
        modo: z.enum(['principal', 'respaldo', 'caido']),
        enviados_hoy: z.number().int().min(0).max(1_000_000).default(0),
        en_cola: z.number().int().min(0).max(1_000_000).default(0),
      }),
      req.body,
    );
    avisos.latidoDetector(b);
    return { ok: true };
  });

  app.get('/api/leads/config', { preHandler: requiereTokenLeads }, async () => {
    const c = await configuracion.obtener();
    return {
      disparadores_portabilidad: c['leads.disparadores_portabilidad'],
      disparadores_fibra: c['leads.disparadores_fibra'],
      companias: c['leads.companias'],
      horas_deduplicacion: c['leads.horas_deduplicacion'],
      antiguedad_max_min: c['leads.antiguedad_max_min'],
    };
  });

  // --- Panel ---

  app.get('/api/leads', { preHandler: requierePermiso('leads.ver') }, async (req) => {
    const f = validar(
      z.object({
        desde: fecha.optional(), hasta: fecha.optional(),
        vendedor_id: z.coerce.number().int().positive().optional(),
        estado: z.enum(['pendiente', 'contactado', 'descartado']).optional(),
        interes: z.enum(['portabilidad', 'fibra']).optional(),
        limite: z.coerce.number().int().min(1).max(2000).default(200),
      }),
      req.query,
    );
    const zona = (await configuracion.obtener())['general.zona_horaria'];
    const condiciones: string[] = [];
    const valores: unknown[] = [zona];
    const agregar = (sql: string, valor: unknown) => {
      valores.push(valor);
      condiciones.push(sql.replace('?', `$${valores.length}`));
    };
    if (f.desde) agregar('av.creado_en >= (?::date)::timestamp AT TIME ZONE $1', f.desde);
    if (f.hasta) agregar('av.creado_en < ((?::date) + 1)::timestamp AT TIME ZONE $1', f.hasta);
    if (f.vendedor_id) agregar('av.vendedor_id = ?', f.vendedor_id);
    if (f.estado) agregar('av.estado = ?', f.estado);
    if (f.interes) agregar('av.interes = ?', f.interes);
    valores.push(f.limite);
    const { rows } = await db.query<Aviso>(
      `SELECT ${COLUMNAS_AVISO} FROM avisos_ivr av ${JOIN_AVISO}
        WHERE av.origen = 'whatsapp' AND $1::text IS NOT NULL ${condiciones.map((c) => `AND ${c}`).join(' ')}
        ORDER BY av.id DESC LIMIT $${valores.length}`,
      valores,
    );
    return rows;
  });

  app.get('/api/leads/resumen', { preHandler: requierePermiso('leads.ver') }, async () => {
    const zona = (await configuracion.obtener())['general.zona_horaria'];
    const hoy = `date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1`;
    const [totales, porVendedor, turno] = await Promise.all([
      db.query<{ hoy: number; portabilidad: number; fibra: number; sin_dni: number; pendientes: number; contactados: number; descartados: number; minutos_hasta_contacto: number | null }>(
        `SELECT count(*) FILTER (WHERE creado_en >= ${hoy})::int AS hoy,
                count(*) FILTER (WHERE creado_en >= ${hoy} AND interes = 'portabilidad')::int AS portabilidad,
                count(*) FILTER (WHERE creado_en >= ${hoy} AND interes = 'fibra')::int AS fibra,
                count(*) FILTER (WHERE creado_en >= ${hoy} AND dni IS NULL)::int AS sin_dni,
                count(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
                count(*) FILTER (WHERE creado_en >= ${hoy} AND estado = 'contactado')::int AS contactados,
                count(*) FILTER (WHERE creado_en >= ${hoy} AND estado = 'descartado')::int AS descartados,
                round(avg(extract(epoch FROM cerrado_en - creado_en) / 60) FILTER (WHERE creado_en >= ${hoy} AND estado = 'contactado')::numeric, 1)::float8 AS minutos_hasta_contacto
           FROM avisos_ivr WHERE origen = 'whatsapp' AND (estado = 'pendiente' OR creado_en >= ${hoy})`,
        [zona],
      ),
      db.query<{ vendedor_id: number; nombre: string; hoy: number; pendientes: number; contactados: number }>(
        `SELECT av.vendedor_id, u.nombre,
                count(*) FILTER (WHERE av.creado_en >= ${hoy})::int AS hoy,
                count(*) FILTER (WHERE av.estado = 'pendiente')::int AS pendientes,
                count(*) FILTER (WHERE av.estado = 'contactado' AND av.creado_en >= ${hoy})::int AS contactados
           FROM avisos_ivr av JOIN usuarios u ON u.id = av.vendedor_id
          WHERE av.origen = 'whatsapp' AND (av.estado = 'pendiente' OR av.creado_en >= ${hoy})
          GROUP BY av.vendedor_id, u.nombre ORDER BY u.nombre`,
        [zona],
      ),
      avisos.turnoLeads(zona),
    ]);
    const ahora = Date.now();
    return {
      hoy: totales.rows[0],
      vendedores: porVendedor.rows.map((v) => ({ ...v, conectado: avisos.conectado(v.vendedor_id) })),
      turno,
      detectores: [...avisos.detectores.values()].map((d) => ({
        ...d,
        ultimo_latido: new Date(d.ultimo_latido).toISOString(),
        vivo: ahora - d.ultimo_latido < LATIDO_VIGENTE_MS,
      })),
    };
  });

  // --- Reglas de reparto (migración 010): quién recibe los leads según el día y el horario ---
  // Se recalcula en cada lead, así que un cambio vale para el próximo; los pendientes siguen con
  // quien los tenía. Solo vendedores activos.
  const permisoReglas = requierePermiso('leads.editar', 'vendedores.ivr');
  const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato HH:MM');
  const esquemaRegla = z.object({
    nombre: z.string().trim().min(2).max(80),
    dias: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform((d) => [...new Set(d)].sort()),
    desde: hora,
    hasta: hora,
    modo: z.enum(['conectadas', 'todas']),
    activa: z.boolean(),
    vendedores: z.array(z.number().int().positive()).max(500),
  });

  app.get('/api/leads/reglas', { preHandler: permisoReglas }, async () => {
    const zona = (await configuracion.obtener())['general.zona_horaria'];
    const [reglas, vendedores, turno] = await Promise.all([
      avisos.reglasLeads(),
      db.query<{ id: number; nombre: string; pendientes: number }>(
        `SELECT u.id, u.nombre,
                (SELECT count(*)::int FROM avisos_ivr av WHERE av.vendedor_id = u.id AND av.origen = 'whatsapp' AND av.estado = 'pendiente') AS pendientes
           FROM usuarios u WHERE u.activo AND u.rol = 'vendedor' ORDER BY u.nombre`,
      ),
      avisos.turnoLeads(zona),
    ]);
    return {
      reglas,
      vendedores: vendedores.rows.map((v) => ({ ...v, conectado: avisos.conectado(v.id) })),
      vigente: turno.regla?.id ?? null,
      proximo: turno.proximo,
    };
  });

  /** Guarda los vendedores de una regla (solo vendedores activos) dentro de una transacción. */
  async function guardarVendedores(tx: import('pg').PoolClient, reglaId: number, ids: number[]): Promise<void> {
    await tx.query('DELETE FROM leads_regla_vendedores WHERE regla_id = $1', [reglaId]);
    if (ids.length) {
      await tx.query(
        `INSERT INTO leads_regla_vendedores (regla_id, usuario_id)
           SELECT $1, u.id FROM usuarios u WHERE u.id = ANY($2) AND u.activo AND u.rol = 'vendedor'`,
        [reglaId, ids],
      );
    }
  }

  app.post('/api/leads/reglas', { preHandler: permisoReglas }, async (req, reply) => {
    const yo = usuarioDe(req);
    const r = validar(esquemaRegla.strict(), req.body);
    if (r.desde === r.hasta) throw errorHttp(400, 'El horario tiene que empezar y terminar a distinta hora');
    const id = await conTransaccion(db, async (tx) => {
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO leads_reglas (nombre, dias, desde, hasta, modo, activa, orden)
         VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(orden), 0) + 1 FROM leads_reglas WHERE NOT por_defecto))
         RETURNING id`,
        [r.nombre, r.dias, r.desde, r.hasta, r.modo, r.activa],
      );
      await guardarVendedores(tx, rows[0]!.id, r.vendedores);
      return rows[0]!.id;
    });
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'leads.regla.crear', entidad: 'leads_reglas', entidadId: id, detalle: r, ip: req.ip });
    avisos.emit('cambio', null);
    return reply.code(201).send({ id });
  });

  // La regla por defecto solo cambia vendedores y modo (no tiene horario ni se apaga)
  app.patch('/api/leads/reglas/:id', { preHandler: permisoReglas }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const r = validar(esquemaRegla.extend({ orden: z.number().int().min(0).max(999) }).partial().strict(), req.body);
    if (r.desde && r.hasta && r.desde === r.hasta) throw errorHttp(400, 'El horario tiene que empezar y terminar a distinta hora');
    await conTransaccion(db, async (tx) => {
      const { rows } = await tx.query<{ por_defecto: boolean }>('SELECT por_defecto FROM leads_reglas WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw errorHttp(404, 'Regla no encontrada');
      const { vendedores, ...campos } = r;
      if (rows[0].por_defecto) {
        for (const c of ['dias', 'desde', 'hasta', 'activa', 'orden'] as const) delete campos[c];
      }
      const claves = Object.keys(campos) as (keyof typeof campos)[];
      if (claves.length) {
        await tx.query(
          `UPDATE leads_reglas SET ${claves.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [id, ...claves.map((c) => campos[c])],
        );
      }
      if (vendedores) await guardarVendedores(tx, id, vendedores);
    });
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'leads.regla.editar', entidad: 'leads_reglas', entidadId: id, detalle: r, ip: req.ip });
    avisos.emit('cambio', null);
    return { ok: true };
  });

  app.delete('/api/leads/reglas/:id', { preHandler: permisoReglas }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { rowCount } = await db.query('DELETE FROM leads_reglas WHERE id = $1 AND NOT por_defecto', [id]);
    if (!rowCount) throw errorHttp(404, 'Regla no encontrada (la regla por defecto no se borra)');
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'leads.regla.borrar', entidad: 'leads_reglas', entidadId: id, ip: req.ip });
    avisos.emit('cambio', null);
    return { ok: true };
  });

  app.get('/api/leads/tokens', { preHandler: requierePermiso('leads.editar') }, async () => {
    const { rows } = await db.query(
      `SELECT t.id, t.nombre, t.creado_en, u.nombre AS creado_por, t.revocado_en, t.ultimo_uso_en, t.ultimo_ip
         FROM tokens_servicio t LEFT JOIN usuarios u ON u.id = t.creado_por
        WHERE t.alcance = 'leads' ORDER BY t.revocado_en IS NULL DESC, t.id DESC`,
    );
    return rows;
  });

  // El token en claro se devuelve solo acá: en la base queda su hash
  app.post('/api/leads/tokens', { preHandler: requierePermiso('leads.editar') }, async (req, reply) => {
    const yo = usuarioDe(req);
    const { nombre } = validar(z.object({ nombre: z.string().trim().min(2).max(80) }).strict(), req.body);
    const token = PREFIJO_TOKEN + randomBytes(32).toString('base64url');
    const { rows } = await db.query<{ id: number }>(
      "INSERT INTO tokens_servicio (nombre, alcance, hash, creado_por) VALUES ($1, 'leads', $2, $3) RETURNING id",
      [nombre, hashToken(token), yo.id],
    );
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'token_servicio.crear', entidad: 'tokens_servicio', entidadId: rows[0]!.id, detalle: { nombre }, ip: req.ip });
    return reply.code(201).send({ id: rows[0]!.id, nombre, token });
  });

  app.delete('/api/leads/tokens/:id', { preHandler: requierePermiso('leads.editar') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { rowCount } = await db.query("UPDATE tokens_servicio SET revocado_en = now() WHERE id = $1 AND alcance = 'leads' AND revocado_en IS NULL", [id]);
    if (!rowCount) throw errorHttp(404, 'Token no encontrado o ya revocado');
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'token_servicio.revocar', entidad: 'tokens_servicio', entidadId: id, ip: req.ip });
    return { ok: true };
  });
}
