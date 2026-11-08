// Avisos del IVR (el cliente marcó 1 = que lo llamen o 2 = WhatsApp) y sección IVR del panel.
//   /api/avisos/mios       los del vendedor conectado (panel y extensión de Chrome)
//   /api/avisos/esperar    long polling de la extensión: responde apenas le llega un aviso nuevo
//                          (Chrome no deja que la extensión abra un WebSocket a una IP de la LAN)
//   /api/avisos            todos, con filtros (permiso 'ivr.avisos')
//   /api/ivr/resumen       números del día por campaña IVR y turno de los vendedores
//   /api/extension.zip     la extensión de Chrome lista para cargar, apuntando a este servidor
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { COLUMNAS_AVISO, JOIN_AVISO, type Aviso } from '../avisos.js';
import { registrarEnBitacora } from '../bitacora.js';
import { requierePermiso, requiereSesion, usuarioDe } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const DIR_EXTENSION = join(import.meta.dirname, '../../../extension-chrome');
const DIR_DETECTOR = join(import.meta.dirname, '../../../extension-detector');
const ESPERA_LARGA_MS = 25_000;
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato AAAA-MM-DD');

export function rutasAvisos(app: FastifyInstance, { db, avisos, configuracion }: Dependencias): void {
  const esquemaId = z.object({ id: z.coerce.number().int().positive() });

  app.get('/api/avisos/mios', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    avisos.latido(yo.id);
    const [pendientes, recientes] = await Promise.all([
      db.query<Aviso>(
        `SELECT ${COLUMNAS_AVISO} FROM avisos_ivr av ${JOIN_AVISO}
          WHERE av.vendedor_id = $1 AND av.estado = 'pendiente' ORDER BY av.id DESC`,
        [yo.id],
      ),
      db.query<Aviso>(
        `SELECT ${COLUMNAS_AVISO} FROM avisos_ivr av ${JOIN_AVISO}
          WHERE av.vendedor_id = $1 AND av.estado <> 'pendiente' ORDER BY av.cerrado_en DESC NULLS LAST, av.id DESC LIMIT 50`,
        [yo.id],
      ),
    ]);
    return { pendientes: pendientes.rows, recientes: recientes.rows };
  });

  // ?ultimo=<id>: devuelve los avisos del vendedor con id mayor, esperando hasta 25 s a que llegue
  // uno. Sin ?ultimo responde enseguida con el último id (punto de partida, sin avisos).
  app.get('/api/avisos/esperar', { preHandler: requiereSesion }, async (req, reply) => {
    const yo = usuarioDe(req);
    const { ultimo } = validar(z.object({ ultimo: z.coerce.number().int().min(0).optional() }), req.query);
    avisos.latido(yo.id);
    const nuevos = async (desde: number) => (await db.query<Aviso>(
      `SELECT ${COLUMNAS_AVISO} FROM avisos_ivr av ${JOIN_AVISO}
        WHERE av.vendedor_id = $1 AND av.id > $2 AND av.estado = 'pendiente' ORDER BY av.id`,
      [yo.id, desde],
    )).rows;
    if (ultimo === undefined) {
      const { rows } = await db.query<{ max: number | null }>('SELECT max(id)::int AS max FROM avisos_ivr WHERE vendedor_id = $1', [yo.id]);
      return { ultimo: rows[0]?.max ?? 0, avisos: [] };
    }
    // Los que llegan durante la espera vienen por evento (incluye los reasignados, de id viejo).
    // Un cambio en uno de sus avisos (el Detector completó el DNI, lo cerró desde el panel...)
    // también corta la espera, con cambio = true, para que la extensión refresque la lista.
    let lista = await nuevos(ultimo);
    let cambio = false;
    if (lista.length === 0) {
      await new Promise<void>((listo) => {
        const alNuevo = (a: Aviso) => {
          if (a.vendedor_id !== yo.id) return;
          lista.push(a);
          terminar();
        };
        const alCambio = (a: Aviso | null) => {
          if (a?.vendedor_id !== yo.id) return;
          cambio = true;
          terminar();
        };
        const plazo = setTimeout(() => terminar(), ESPERA_LARGA_MS);
        const terminar = () => {
          clearTimeout(plazo);
          avisos.off('nuevo', alNuevo);
          avisos.off('cambio', alCambio);
          reply.raw.off('close', terminar);
          listo();
        };
        avisos.on('nuevo', alNuevo);
        avisos.on('cambio', alCambio);
        reply.raw.on('close', terminar); // la extensión cortó la espera
      });
      if (lista.length === 0) lista = await nuevos(ultimo);
    }
    avisos.latido(yo.id);
    return { ultimo: Math.max(ultimo, ...lista.map((a) => a.id)), avisos: lista, cambio };
  });

  /** El vendedor solo toca los suyos; quien tiene 'ivr.avisos', cualquiera. */
  async function avisoEditable(id: number, yo: ReturnType<typeof usuarioDe>): Promise<void> {
    const { rows } = await db.query<{ vendedor_id: number | null }>('SELECT vendedor_id FROM avisos_ivr WHERE id = $1', [id]);
    if (!rows[0] || (rows[0].vendedor_id !== yo.id && !yo.permisos.has('ivr.avisos'))) throw errorHttp(404, 'Aviso no encontrado');
  }

  app.post('/api/avisos/:id/visto', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    await avisoEditable(id, yo);
    await db.query('UPDATE avisos_ivr SET visto_en = coalesce(visto_en, now()) WHERE id = $1', [id]);
    const aviso = await avisos.buscar(id);
    avisos.emit('cambio', aviso);
    return aviso;
  });

  app.post('/api/avisos/:id/estado', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { estado, notas } = validar(
      z.object({ estado: z.enum(['pendiente', 'contactado', 'descartado']), notas: z.string().trim().max(2000).optional() }).strict(),
      req.body,
    );
    await avisoEditable(id, yo);
    await db.query(
      `UPDATE avisos_ivr SET estado = $2, notas = coalesce($3, notas), visto_en = coalesce(visto_en, now()),
              cerrado_en = CASE WHEN $2 = 'pendiente' THEN NULL ELSE now() END
        WHERE id = $1`,
      [id, estado, notas ?? null],
    );
    const aviso = await avisos.buscar(id);
    avisos.emit('cambio', aviso);
    return aviso;
  });

  // Reasignar a mano (por ejemplo, si el vendedor al que le tocó no vino)
  app.post('/api/avisos/:id/reasignar', { preHandler: requierePermiso('ivr.avisos') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { vendedor_id } = validar(z.object({ vendedor_id: z.number().int().positive() }).strict(), req.body);
    const { rowCount } = await db.query('UPDATE avisos_ivr SET vendedor_id = $2, visto_en = NULL WHERE id = $1', [id, vendedor_id]);
    if (!rowCount) throw errorHttp(404, 'Aviso no encontrado');
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'aviso.reasignar', entidad: 'avisos_ivr', entidadId: id, detalle: { vendedor_id }, ip: req.ip });
    const aviso = await avisos.buscar(id);
    avisos.emit('nuevo', aviso);
    return aviso;
  });

  app.get('/api/avisos', { preHandler: requierePermiso('ivr.avisos') }, async (req) => {
    const f = validar(
      z.object({
        desde: fecha.optional(), hasta: fecha.optional(),
        campana_id: z.coerce.number().int().positive().optional(),
        vendedor_id: z.coerce.number().int().positive().optional(),
        estado: z.enum(['pendiente', 'contactado', 'descartado']).optional(),
        contacto: z.enum(['llamada', 'whatsapp']).optional(),
        origen: z.enum(['ivr', 'whatsapp']).default('ivr'),
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
    if (f.hasta) agregar("av.creado_en < ((?::date) + 1)::timestamp AT TIME ZONE $1", f.hasta);
    if (f.campana_id) agregar('av.campana_id = ?', f.campana_id);
    if (f.vendedor_id) agregar('av.vendedor_id = ?', f.vendedor_id);
    if (f.estado) agregar('av.estado = ?', f.estado);
    if (f.contacto) agregar('av.contacto = ?', f.contacto);
    agregar('av.origen = ?', f.origen);
    valores.push(f.limite);
    const { rows } = await db.query<Aviso>(
      `SELECT ${COLUMNAS_AVISO} FROM avisos_ivr av ${JOIN_AVISO}
        WHERE $1::text IS NOT NULL ${condiciones.map((c) => `AND ${c}`).join(' ')}
        ORDER BY av.id DESC LIMIT $${valores.length}`,
      valores,
    );
    return rows;
  });

  app.get('/api/ivr/resumen', { preHandler: requierePermiso('ivr.ver', 'ivr.avisos') }, async () => {
    const zona = (await configuracion.obtener())['general.zona_horaria'];
    const hoy = `date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1`;
    const [campanas, llamadas, porAvisos, porVendedor] = await Promise.all([
      db.query<{ id: number; nombre: string; estado: string; ivr_destino: string; audio_id: number | null; audio_b_id: number | null; audio_b_pct: number; ivr_tecla_llamada: string | null; ivr_tecla_whatsapp: string | null; restantes: number }>(
        `SELECT c.id, c.nombre, c.estado, c.ivr_destino, c.audio_id, c.audio_b_id, c.audio_b_pct, c.ivr_tecla_llamada, c.ivr_tecla_whatsapp,
                (SELECT count(*)::int FROM leads l JOIN listas li ON li.id = l.lista_id AND li.activa
                  WHERE l.campana_id = c.id AND l.estado IN ('pendiente', 'reintentar')) AS restantes
           FROM campanas c WHERE c.tipo = 'ivr' AND c.estado <> 'archivada' ORDER BY c.estado = 'activa' DESC, c.id DESC`,
      ),
      db.query<{ campana_id: number; intentos: number; atendidas: number; contestadores: number; cortaron: number; sin_marcar: number; no_llame: number; avisos: number }>(
        `SELECT campana_id, count(*)::int AS intentos,
                count(*) FILTER (WHERE contestada_en IS NOT NULL)::int AS atendidas,
                count(*) FILTER (WHERE resultado = 'contestador')::int AS contestadores,
                count(*) FILTER (WHERE resultado = 'corto_en_mensaje')::int AS cortaron,
                count(*) FILTER (WHERE resultado = 'sin_confirmar')::int AS sin_marcar,
                count(*) FILTER (WHERE resultado = 'no_llame_ivr')::int AS no_llame,
                count(*) FILTER (WHERE resultado = 'aviso_ivr')::int AS avisos
           FROM llamadas WHERE tipo_campana = 'ivr' AND inicio >= ${hoy} GROUP BY campana_id`,
        [zona],
      ),
      db.query<{ campana_id: number; llamada: number; whatsapp: number }>(
        `SELECT campana_id, count(*) FILTER (WHERE contacto = 'llamada')::int AS llamada,
                count(*) FILTER (WHERE contacto = 'whatsapp')::int AS whatsapp
           FROM avisos_ivr WHERE creado_en >= ${hoy} GROUP BY campana_id`,
        [zona],
      ),
      db.query<{ vendedor_id: number; nombre: string; hoy: number; pendientes: number; contactados: number }>(
        `SELECT av.vendedor_id, u.nombre,
                count(*) FILTER (WHERE av.creado_en >= ${hoy})::int AS hoy,
                count(*) FILTER (WHERE av.estado = 'pendiente')::int AS pendientes,
                count(*) FILTER (WHERE av.estado = 'contactado' AND av.creado_en >= ${hoy})::int AS contactados
           FROM avisos_ivr av JOIN usuarios u ON u.id = av.vendedor_id
          WHERE av.origen = 'ivr' AND (av.estado = 'pendiente' OR av.creado_en >= ${hoy})
          GROUP BY av.vendedor_id, u.nombre`,
        [zona],
      ),
    ]);
    const porCampana = new Map(llamadas.rows.map((r) => [r.campana_id, r]));
    const avisosPorCampana = new Map(porAvisos.rows.map((r) => [r.campana_id, r]));
    return {
      campanas: await Promise.all(
        campanas.rows.map(async (c) => ({
          ...c,
          hoy: porCampana.get(c.id) ?? null,
          avisos_hoy: avisosPorCampana.get(c.id) ?? { llamada: 0, whatsapp: 0 },
          turno: c.ivr_destino === 'aviso' ? await avisos.turno(c.id) : null,
        })),
      ),
      vendedores: porVendedor.rows.map((v) => ({ ...v, conectado: avisos.conectado(v.vendedor_id) })),
    };
  });

  // Las extensiones se arman al vuelo con la dirección de este servidor ya cargada: la de los
  // vendedores (avisos del IVR y leads) y el Detector de leads de la PC del bot de WhatsApp
  const descargarExtension = (dir: string, carpeta: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    const servidor = `https://${req.headers.host ?? 'localhost:5173'}`;
    const archivos: { nombre: string; datos: Buffer }[] = [];
    const recorrer = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const ruta = join(d, e.name);
        if (e.isDirectory()) await recorrer(ruta);
        else archivos.push({ nombre: `${carpeta}/${relative(dir, ruta)}`, datos: await readFile(ruta) });
      }
    };
    await recorrer(dir);
    for (const a of archivos) {
      if (a.nombre === `${carpeta}/config.js`) a.datos = Buffer.from(a.datos.toString('utf8').replace("SERVIDOR_POR_DEFECTO = ''", `SERVIDOR_POR_DEFECTO = '${servidor}'`));
    }
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${carpeta}.zip"`)
      .send(armarZip(archivos));
  };
  app.get('/api/extension.zip', descargarExtension(DIR_EXTENSION, 'discador-avisos'));
  // El Detector no tiene claves adentro (el token se carga en sus opciones), pero solo lo baja quien configura leads
  app.get('/api/detector.zip', { preHandler: requierePermiso('leads.editar') }, descargarExtension(DIR_DETECTOR, 'discador-detector'));
}

/** ZIP mínimo (deflate, sin carpetas ni extras): alcanza para que lo abra cualquier descompresor. */
function armarZip(archivos: { nombre: string; datos: Buffer }[]): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let desplazamiento = 0;
  for (const a of archivos) {
    const nombre = Buffer.from(a.nombre, 'utf8');
    const comprimido = deflateRawSync(a.datos);
    const crc = crc32(a.datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // hora y fecha: sin dato
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(a.datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(a.datos.length, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt32LE(desplazamiento, 42);
    locales.push(local, nombre, comprimido);
    centrales.push(central, nombre);
    desplazamiento += local.length + nombre.length + comprimido.length;
  }
  const tamCentral = centrales.reduce((t, b) => t + b.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(tamCentral, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...locales, ...centrales, fin]);
}
