// Avisos del IVR: el cliente marcó la tecla de llamada o de WhatsApp y su número le llega a un
// vendedor, por turno entre los asignados a la campaña que reciben IVR (1, 2, 3, 1, 2…).
//
// Leads del bot de WhatsApp (origen 'whatsapp', migración 008): misma tabla y mismas rutas para el
// vendedor, pero otra cola con su propio turno, según las reglas de reparto por día y horario de la
// sección Leads (migración 010; leadsReglas.ts). Un mismo
// número genera un solo lead por ventana de deduplicación; los mensajes siguientes lo completan.
//
// El turno sigue al último aviso de la campaña, así que sobrevive a un reinicio. Entre los
// vendedores, primero se reparte entre los que tienen la extensión o el panel abiertos; si no hay
// ninguno, igual se asigna por turno y lo ven al conectarse.
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { reglaVigente, type ReglaLeads } from './leadsReglas.js';
import type { AvisoIvr } from './telefonia/conmutador.js';

export interface Aviso {
  id: number;
  llamada_id: number | null;
  campana_id: number | null;
  campana: string | null;
  lead_id: number | null;
  telefono: string;
  nombre: string | null;
  contacto: 'llamada' | 'whatsapp';
  tecla: string;
  vendedor_id: number | null;
  vendedor: string | null;
  estado: 'pendiente' | 'contactado' | 'descartado';
  visto_en: string | null;
  cerrado_en: string | null;
  notas: string | null;
  creado_en: string;
  // Leads del bot de WhatsApp (origen 'whatsapp'): sin llamada ni tecla
  origen: 'ivr' | 'whatsapp';
  dni: string | null;
  dni_texto: string | null;
  compania: string | null;
  interes: 'portabilidad' | 'fibra' | null;
  direccion: string | null;
  chat_hora: string | null;
  actualizado_en: string | null;
}

/** Lo que manda el Detector de la PC del bot (ya validado y con el teléfono normalizado). */
export interface DatosLead {
  telefono: string;
  nombre: string | null;
  dni: string | null;
  dni_texto: string | null;
  compania: string | null;
  interes: 'portabilidad' | 'fibra' | null;
  direccion: string | null;
  chat_hora: string | null;
  pc_bot: string | null;
}

export interface EstadoDetector {
  pc_bot: string;
  version: string | null;
  modo: 'principal' | 'respaldo' | 'caido';
  enviados_hoy: number;
  en_cola: number;
  ultimo_latido: number;
}

export const COLUMNAS_AVISO = `av.id::int, av.llamada_id::int, av.campana_id, c.nombre AS campana, av.lead_id::int, av.telefono, av.nombre,
  av.contacto, av.tecla, av.vendedor_id, u.nombre AS vendedor, av.estado, av.visto_en, av.cerrado_en, av.notas, av.creado_en,
  av.origen, av.dni, av.dni_texto, av.compania, av.interes, av.direccion, av.chat_hora, av.actualizado_en`;
export const JOIN_AVISO = `LEFT JOIN campanas c ON c.id = av.campana_id LEFT JOIN usuarios u ON u.id = av.vendedor_id`;

const LATIDO_VIGENTE_MS = 75_000;

export class Avisos extends EventEmitter {
  /** usuario -> conexiones abiertas (WebSocket del panel o de la extensión) */
  private readonly enLinea = new Map<number, number>();
  /** usuario -> última consulta de sus avisos: la extensión consulta cada 30 s aunque no tenga WebSocket */
  private readonly latidos = new Map<number, number>();
  /** Los repartos van de a uno: dos avisos simultáneos no pueden tocarle al mismo por leer el mismo turno */
  private cola: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: pg.Pool,
    private readonly log: { error: (o: object, m?: string) => void },
  ) {
    super();
    this.setMaxListeners(0); // cada extensión esperando avisos (long polling) es un oyente
  }

  conectar(usuarioId: number): void {
    this.enLinea.set(usuarioId, (this.enLinea.get(usuarioId) ?? 0) + 1);
  }

  desconectar(usuarioId: number): void {
    const n = (this.enLinea.get(usuarioId) ?? 1) - 1;
    if (n > 0) this.enLinea.set(usuarioId, n);
    else this.enLinea.delete(usuarioId);
  }

  latido(usuarioId: number): void {
    this.latidos.set(usuarioId, Date.now());
  }

  conectado(usuarioId: number): boolean {
    return this.enLinea.has(usuarioId) || Date.now() - (this.latidos.get(usuarioId) ?? 0) < LATIDO_VIGENTE_MS;
  }

  crear(d: AvisoIvr): Promise<void> {
    const tarea = this.cola.then(() => this.repartir(d));
    this.cola = tarea.catch((err: unknown) => this.log.error({ err, llamada: d.llamadaId }, 'No se pudo repartir el aviso del IVR'));
    return tarea;
  }

  /** Vendedores de la campaña en el orden del turno, y a quién le toca el próximo aviso. */
  async turno(campanaId: number): Promise<{ vendedores: { id: number; nombre: string; conectado: boolean }[]; proximo: number | null }> {
    const [vendedores, ultimo] = await Promise.all([
      this.db.query<{ id: number; nombre: string }>(
        `SELECT u.id, u.nombre FROM campana_vendedores cv
           JOIN usuarios u ON u.id = cv.usuario_id AND u.activo AND u.recibe_ivr
          WHERE cv.campana_id = $1 ORDER BY u.id`,
        [campanaId],
      ),
      this.db.query<{ vendedor_id: number }>(
        'SELECT vendedor_id FROM avisos_ivr WHERE campana_id = $1 AND vendedor_id IS NOT NULL ORDER BY id DESC LIMIT 1',
        [campanaId],
      ),
    ]);
    const lista = vendedores.rows.map((v) => ({ ...v, conectado: this.conectado(v.id) }));
    const candidatos = lista.some((v) => v.conectado) ? lista.filter((v) => v.conectado) : lista;
    const anterior = ultimo.rows[0]?.vendedor_id ?? 0;
    const proximo = candidatos.find((v) => v.id > anterior) ?? candidatos[0];
    return { vendedores: lista, proximo: proximo?.id ?? null };
  }

  private async repartir(d: AvisoIvr): Promise<void> {
    const { proximo } = await this.turno(d.campanaId);
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO avisos_ivr (llamada_id, campana_id, lead_id, telefono, nombre, contacto, tecla, vendedor_id)
       VALUES ($1, $2, $3, $4, (SELECT nombre FROM leads WHERE id = $3), $5, $6, $7) RETURNING id`,
      [d.llamadaId, d.campanaId, d.leadId, d.telefono, d.contacto, d.tecla, proximo],
    );
    const aviso = await this.buscar(Number(rows[0]!.id));
    this.emit('nuevo', aviso);
  }

  // --- Leads del bot de WhatsApp: otra cola, con su propio turno entre los que tienen "Recibe leads" ---

  /** Detectores que mandaron latido (uno por PC del bot): el panel muestra si siguen vivos. */
  readonly detectores = new Map<string, EstadoDetector>();

  latidoDetector(e: Omit<EstadoDetector, 'ultimo_latido'>): void {
    this.detectores.set(e.pc_bot, { ...e, ultimo_latido: Date.now() });
  }

  async reglasLeads(): Promise<ReglaLeads[]> {
    const { rows } = await this.db.query<ReglaLeads>(
      `SELECT r.id, r.nombre, r.por_defecto, r.dias::int[] AS dias, to_char(r.desde, 'HH24:MI') AS desde, to_char(r.hasta, 'HH24:MI') AS hasta,
              r.modo, r.activa, r.orden,
              coalesce((SELECT array_agg(rv.usuario_id ORDER BY rv.usuario_id) FROM leads_regla_vendedores rv
                         JOIN usuarios u ON u.id = rv.usuario_id AND u.activo WHERE rv.regla_id = r.id), '{}') AS vendedores
         FROM leads_reglas r ORDER BY r.orden, r.id`,
    );
    return rows;
  }

  /**
   * Turno de los leads según la regla que vale ahora (día y horario en la zona de la oficina):
   * modo 'conectadas' reparte solo entre las de la regla que están conectadas (si no hay ninguna,
   * entre todas las de la regla); modo 'todas', entre todas aunque estén desconectadas.
   */
  async turnoLeads(zona: string): Promise<{
    regla: { id: number; nombre: string; modo: ReglaLeads['modo'] } | null;
    vendedores: { id: number; nombre: string; conectado: boolean }[];
    proximo: number | null;
  }> {
    const [reglas, ultimo] = await Promise.all([
      this.reglasLeads(),
      this.db.query<{ vendedor_id: number }>(
        "SELECT vendedor_id FROM avisos_ivr WHERE origen = 'whatsapp' AND vendedor_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      ),
    ]);
    const regla = reglaVigente(reglas, new Date(), zona);
    if (!regla) return { regla: null, vendedores: [], proximo: null };
    const { rows } = await this.db.query<{ id: number; nombre: string }>(
      'SELECT id, nombre FROM usuarios WHERE id = ANY($1) AND activo ORDER BY id',
      [regla.vendedores],
    );
    const lista = rows.map((v) => ({ ...v, conectado: this.conectado(v.id) }));
    const conectados = lista.filter((v) => v.conectado);
    const candidatos = regla.modo === 'conectadas' && conectados.length ? conectados : lista;
    const anterior = ultimo.rows[0]?.vendedor_id ?? 0;
    const proximo = candidatos.find((v) => v.id > anterior) ?? candidatos[0];
    return { regla: { id: regla.id, nombre: regla.nombre, modo: regla.modo }, vendedores: lista, proximo: proximo?.id ?? null };
  }

  /**
   * Un lead nuevo, o el mismo número dentro de la ventana de deduplicación: en ese caso no se crea
   * otro sino que se completan los datos que faltaban (el DNI que mandó en un segundo mensaje, la
   * dirección de fibra...) y se avisa el cambio. Va por la misma cola que los repartos del IVR.
   */
  registrarLead(d: DatosLead, horasDeduplicacion: number, zona: string): Promise<{ aviso: Aviso; nuevo: boolean }> {
    const tarea = this.cola.then(() => this.guardarLead(d, horasDeduplicacion, zona));
    this.cola = tarea.catch((err: unknown) => this.log.error({ err }, 'No se pudo registrar el lead de WhatsApp'));
    return tarea;
  }

  private async guardarLead(d: DatosLead, horas: number, zona: string): Promise<{ aviso: Aviso; nuevo: boolean }> {
    const { rows: previos } = await this.db.query<{ id: number }>(
      `SELECT id::int FROM avisos_ivr
        WHERE origen = 'whatsapp' AND telefono = $1 AND creado_en > now() - make_interval(hours => $2)
        ORDER BY id DESC LIMIT 1`,
      [d.telefono, horas],
    );
    if (previos[0]) {
      const actual = await this.buscar(previos[0].id);
      // Solo se completa lo que faltaba: un dato ya cargado no se pisa con uno posterior. El
      // interés sí pasa a fibra si llega más tarde (el pedido de DNI es el mismo en las dos ramas).
      const cambios: Partial<Record<'dni' | 'dni_texto' | 'compania' | 'interes' | 'direccion' | 'nombre', string>> = {};
      for (const campo of ['dni', 'dni_texto', 'compania', 'direccion', 'nombre'] as const) {
        if (actual[campo] === null && d[campo] !== null) cambios[campo] = d[campo];
      }
      if (d.interes && actual.interes !== d.interes && (actual.interes === null || d.interes === 'fibra')) cambios.interes = d.interes;
      const campos = Object.keys(cambios) as (keyof typeof cambios)[];
      if (campos.length === 0) return { aviso: actual, nuevo: false };
      await this.db.query(
        `UPDATE avisos_ivr SET ${campos.map((c, i) => `${c} = $${i + 2}`).join(', ')}, actualizado_en = now() WHERE id = $1`,
        [actual.id, ...campos.map((c) => cambios[c])],
      );
      const aviso = await this.buscar(actual.id);
      this.emit('cambio', aviso);
      return { aviso, nuevo: false };
    }
    const { proximo } = await this.turnoLeads(zona);
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO avisos_ivr (origen, telefono, nombre, contacto, vendedor_id, dni, dni_texto, compania, interes, direccion, chat_hora, pc_bot)
       VALUES ('whatsapp', $1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::int`,
      [d.telefono, d.nombre, proximo, d.dni, d.dni_texto, d.compania, d.interes, d.direccion, d.chat_hora, d.pc_bot],
    );
    const aviso = await this.buscar(rows[0]!.id);
    this.emit('nuevo', aviso);
    return { aviso, nuevo: true };
  }

  async buscar(id: number): Promise<Aviso> {
    const { rows } = await this.db.query<Aviso>(`SELECT ${COLUMNAS_AVISO} FROM avisos_ivr av ${JOIN_AVISO} WHERE av.id = $1`, [id]);
    return rows[0]!;
  }
}
