// Conmutador: líneas de los vendedores y ciclo de vida de cada llamada.
//
//   originar ─► contesta ─► [AMD] ─► [audio + teclas / permanencia] ─► cola (música) ─► vendedor
//        │                    │              │                             │
//        └ no contesta,       └ contestador  └ cortó en el mensaje,        └ abandonada (espera vencida)
//          ocupado, falla                      sin confirmar, No Llame        → derivación si es IVR
//
// IVR con aviso (ivr_destino = 'aviso'): después del mensaje el cliente marca la tecla de llamada
// o la de WhatsApp, escucha la despedida y se corta; el número sale como aviso ('aviso_ivr') para
// que lo reparta src/avisos.ts.
//
// Prueba del IVR (origen 'prueba'): el mismo flujo de una campaña IVR con aviso hacia un número
// cualquiera, sin repartir el aviso ni contar en las estadísticas (se guarda sin campaña).
//
// Audios A y B: si la campaña tiene audio B, cada llamada que pasa la detección escucha uno u otro
// según audio_b_pct (elegirAudio) y llamadas.audio_id guarda cuál, para compararlos.
//
// El estado en vivo vive en memoria (un solo proceso); la base guarda cada fase para los reportes.
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { config } from '../config.js';
import type { AriCliente, AriEvento } from '../ari/cliente.js';
import type { Config } from '../configuracion.js';
import { bloquearNumero, estaBloqueado } from '../noLlame.js';
import { normalizarTelefono } from '../telefonos.js';
import { motivoFueraDeHorario, momentoEn, type ReglasHorario } from './horario.js';

export type TipoCampana = 'manual' | 'progresivo' | 'predictivo' | 'predictivo_audio' | 'ivr';
export type EstadoPuesto = 'disponible' | 'en_llamada' | 'tipificando' | 'descanso';
export type FaseLlamada = 'marcando' | 'amd' | 'audio' | 'espera_tecla' | 'permanencia' | 'despedida' | 'cola' | 'conversacion';
export type Resultado =
  | 'no_contesta' | 'ocupado' | 'fallida' | 'contestador' | 'atendida' | 'abandonada'
  | 'corto_en_mensaje' | 'sin_confirmar' | 'no_llame_ivr' | 'aviso_ivr';
type QuienColgo = 'cliente' | 'vendedor' | 'sistema';

/** Lo que el conmutador necesita de la campaña durante la llamada (se copia al originar). */
export interface ParametrosCampana {
  id: number;
  nombre: string;
  tipo: TipoCampana;
  prioridad: number;
  amd_activo: boolean;
  grabar: boolean;
  audio_id: number | null;
  audio_archivo: string | null;
  audio_b_id: number | null;
  audio_b_archivo: string | null;
  audio_b_pct: number; // parte de las llamadas que escucha el audio B (0 a 100)
  ivr_modo: 'presione_1' | 'permanencia' | 'cualquiera';
  ivr_tecla_pase: string;
  ivr_tecla_no_llame: string | null;
  ivr_espera_seg: number;
  ivr_repeticiones: number;
  ivr_destino: 'vendedor' | 'aviso';
  ivr_tecla_llamada: string | null;
  ivr_tecla_whatsapp: string | null;
  audio_despedida_archivo: string | null;
  espera_max_seg: number;
  max_intentos: number;
  minutos_reintento: number;
  segundos_timbre: number;
}

/** Columnas de ParametrosCampana (alias c = campanas, a y ab = audios A y B del mensaje, ad = audio de despedida). */
export const COLUMNAS_PARAMETROS = `c.id, c.nombre, c.tipo, c.prioridad, c.amd_activo, c.grabar, c.audio_id, a.archivo AS audio_archivo,
  c.audio_b_id, ab.archivo AS audio_b_archivo, c.audio_b_pct, c.ivr_modo, c.ivr_tecla_pase, c.ivr_tecla_no_llame, c.ivr_espera_seg, c.ivr_repeticiones, c.ivr_destino,
  c.ivr_tecla_llamada, c.ivr_tecla_whatsapp, ad.archivo AS audio_despedida_archivo, c.espera_max_seg,
  c.max_intentos, c.minutos_reintento, c.segundos_timbre`;
export const JOIN_AUDIOS_PARAMETROS = `LEFT JOIN audios a ON a.id = c.audio_id LEFT JOIN audios ab ON ab.id = c.audio_b_id
  LEFT JOIN audios ad ON ad.id = c.ivr_audio_despedida_id`;

/** Audio del mensaje que escucha una llamada (el A o el B de la campaña). */
export interface AudioMensaje {
  id: number;
  archivo: string;
}

/** El cliente marcó en un IVR con aviso: lo reparte src/avisos.ts. */
export interface AvisoIvr {
  llamadaId: number;
  campanaId: number;
  leadId: number | null;
  telefono: string;
  contacto: 'llamada' | 'whatsapp';
  tecla: string;
}

export interface GatewayVivo {
  id: number;
  nombre: string;
  endpoint: string;
  canales: number;
  reservados: number;
  llamadasPorSegundo: number | null;
  orden: number;
}

/** Antigüedad mínima de una llamada para que el vigilante la cierre por falta de canal (el originate tarda). */
const MARGEN_VIGILANTE_MS = 15_000;

// Tono de llamada de Argentina (425 Hz, 1 s sonando, 4 s en silencio), de la zona 'ar' de
// asterisk/indications.conf. No se puede describir el tono acá: ARI toma las comas como una
// lista de audios ('425/1000,0/4000' se partía en dos y fallaba).
const TONO_LLAMADA = 'tone:ring;tonezone=ar';

interface Llamada {
  id: number;
  canalId: string;
  origen: 'discador' | 'manual' | 'ivr' | 'prueba';
  campana: ParametrosCampana | null;
  leadId: number | null;
  telefono: string;
  gatewayId: number;
  fase: FaseLlamada;
  inicio: number;
  contestada: boolean;
  conectada: boolean; // llegó al vendedor
  vendedorId: number | null;
  enDialplan: boolean;
  temporizador?: NodeJS.Timeout;
  repeticionesRestantes: number;
  audio?: AudioMensaje; // se elige al pasar la detección (en la prueba, el que se pidió)
  reproduciendo?: string; // playbackId en curso
  enColaDesde?: number;
  grabacion?: string;
  tecla?: string;
  tonoLlamada?: string; // playback del tono de llamada en la línea del vendedor (manuales)
  enBridgeTemprano?: boolean; // manual: el canal está en el bridge del vendedor desde antes de atender
  grabacionAmd?: string; // grabación de los segundos de la detección de contestador
  amdEstado?: string;
  amdCausa?: string;
  colgo?: QuienColgo;
  terminada: boolean;
}

interface Puesto {
  usuarioId: number;
  nombre: string;
  interno: string;
  rol: 'vendedor' | 'supervisor' | 'admin';
  canalLinea: string;
  bridgeId: string;
  lineaTemporal: boolean; // abierta por una llamada manual desde un softphone, se cierra al terminar
  estado: EstadoPuesto;
  motivoDescansoId: number | null;
  desde: number;
  libreDesde: number;
  llamadaId: number | null;
  ultimaLlamadaId: number | null;
  recibeIvr: boolean;
  puedeManual: boolean;
  tope: number | null;
  espia?: { modo: 'escuchar' | 'susurrar' | 'intervenir'; vendedorId: number; canalId: string };
}

/** Eventos recientes por campaña para el ritmo del predictivo y el control de abandono. */
interface Estadistica {
  intentos: number[];
  humanos: number[]; // contestó una persona y pasó los filtros (llegó a la cola o al vendedor)
  conectadas: number[];
  abandonos: number[];
}

const VENTANA_ESTADISTICA_MS = 30 * 60_000;
const MARGEN_AMD_MS = 4_000;

export class Conmutador extends EventEmitter {
  private readonly llamadas = new Map<number, Llamada>();
  private readonly porCanal = new Map<string, number>();
  private readonly puestos = new Map<number, Puesto>();
  private readonly enUso = new Map<number, { total: number; auto: number; disparos: number[] }>();
  private readonly estadisticas = new Map<number, Estadistica>();
  // Reparto de los audios A y B por campaña: se reinicia si cambian los audios o el %
  private readonly repartoAudios = new Map<number, { clave: string; acumulado: number }>();

  // Los actualiza el motor en cada ciclo
  config!: Config;
  reglas: ReglasHorario = { global: [], bloqueos: [] };
  gateways: GatewayVivo[] = [];
  asignaciones = new Map<number, Set<number>>(); // campaña -> vendedores asignados

  constructor(
    private readonly db: pg.Pool,
    private readonly ari: AriCliente,
    private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void },
  ) {
    super();
    const manejar = (fn: (e: AriEvento) => Promise<void>) => (e: AriEvento) => {
      fn.call(this, e).catch((err: unknown) => this.log.error({ err, evento: e.type }, 'Error manejando evento de ARI'));
    };
    ari.on('StasisStart', manejar(this.alEntrarEnStasis));
    ari.on('ChannelDestroyed', manejar(this.alDestruirseCanal));
    ari.on('ChannelDtmfReceived', manejar(this.alRecibirTecla));
    ari.on('PlaybackFinished', manejar(this.alTerminarAudio));
    ari.on('EndpointStateChange', manejar(this.alCambiarEndpoint));
    ari.on('ChannelStateChange', manejar(this.alCambiarEstadoCanal));
  }

  /** Tras un reinicio: nada queda "en curso" para siempre. */
  async recuperar(): Promise<void> {
    await this.db.query("UPDATE leads SET estado = 'reintentar', proximo_intento = now() WHERE estado = 'en_curso'");
    await this.db.query("UPDATE llamadas SET fin = now(), resultado = COALESCE(resultado, 'fallida') WHERE fin IS NULL");
  }

  // =====================================================================
  //  Consultas para el motor, la API y el monitor
  // =====================================================================

  puesto(usuarioId: number): Puesto | undefined {
    return this.puestos.get(usuarioId);
  }

  /** Vendedores libres que pueden atender la campaña. */
  libresPara(campana: { id: number; tipo: TipoCampana }): Puesto[] {
    return [...this.puestos.values()].filter((p) => p.estado === 'disponible' && this.puedeAtender(p, campana));
  }

  llamadasDe(campanaId: number): { enVuelo: number; activas: number } {
    let enVuelo = 0;
    let activas = 0;
    for (const l of this.llamadas.values()) {
      if (l.campana?.id !== campanaId || l.origen === 'prueba') continue;
      activas++;
      if (!l.conectada) enVuelo++;
    }
    return { enVuelo, activas };
  }

  telefonoEnCurso(telefono: string): boolean {
    for (const l of this.llamadas.values()) if (l.telefono === telefono) return true;
    return false;
  }

  estadistica(campanaId: number): { intentos: number; humanos: number; conectadas: number; abandonos: number } {
    const e = this.estadisticaDe(campanaId);
    const desde = Date.now() - VENTANA_ESTADISTICA_MS;
    for (const lista of Object.values(e)) while (lista.length && lista[0]! < desde) lista.shift();
    return { intentos: e.intentos.length, humanos: e.humanos.length, conectadas: e.conectadas.length, abandonos: e.abandonos.length };
  }

  /** Llamadas que lanzó la campaña en los últimos `ms` (sin las pruebas). */
  disparosDe(campanaId: number, ms: number): number {
    const desde = Date.now() - ms;
    const intentos = this.estadisticaDe(campanaId).intentos;
    let n = 0;
    for (let i = intentos.length - 1; i >= 0 && intentos[i]! >= desde; i--) n++;
    return n;
  }

  disparosUltimoMinuto(): number {
    const desde = Date.now() - 60_000;
    let n = 0;
    for (const u of this.enUso.values()) n += u.disparos.filter((t) => t >= desde).length;
    return n;
  }

  /** Gateway con lugar: por orden, respetando la reserva para manual y las llamadas por segundo. */
  elegirGateway(permitidos: number[] | null, manual: boolean): GatewayVivo | null {
    const ahora = Date.now();
    for (const g of this.gateways) {
      if (permitidos && !permitidos.includes(g.id)) continue;
      const u = this.usoDe(g.id);
      if (u.total >= g.canales) continue;
      if (!manual && u.auto >= g.canales - g.reservados) continue;
      if (g.llamadasPorSegundo && u.disparos.filter((t) => t > ahora - 1000).length >= g.llamadasPorSegundo) continue;
      return g;
    }
    return null;
  }

  instantanea() {
    const ahora = Date.now();
    return {
      ts: ahora,
      puestos: [...this.puestos.values()].map((p) => ({
        usuario_id: p.usuarioId, nombre: p.nombre, interno: p.interno, rol: p.rol, estado: p.estado,
        motivo_descanso_id: p.motivoDescansoId, desde: p.desde, llamada_id: p.llamadaId,
        telefono: p.llamadaId ? this.llamadas.get(p.llamadaId)?.telefono ?? null : null,
        segundos_libre: p.estado === 'disponible' ? Math.round((ahora - p.libreDesde) / 1000) : null,
        espia: p.espia ? { modo: p.espia.modo, vendedor_id: p.espia.vendedorId } : null,
      })),
      llamadas: [...this.llamadas.values()].map((l) => ({
        id: l.id, fase: l.fase, telefono: l.telefono, origen: l.origen, campana_id: l.campana?.id ?? null,
        campana: l.campana?.nombre ?? null, gateway_id: l.gatewayId, vendedor_id: l.vendedorId,
        segundos: Math.round((ahora - l.inicio) / 1000),
        segundos_en_cola: l.enColaDesde && l.fase === 'cola' ? Math.round((ahora - l.enColaDesde) / 1000) : null,
      })),
      gateways: this.gateways.map((g) => {
        const u = this.usoDe(g.id);
        return {
          id: g.id, nombre: g.nombre, canales: g.canales, reservados_manual: g.reservados,
          en_uso: u.total, en_uso_discador: u.auto, libres: g.canales - u.total,
          ocupacion_pct: Math.round((u.total / g.canales) * 100),
        };
      }),
    };
  }

  // =====================================================================
  //  Originar
  // =====================================================================

  /** Llamada del discador (lead ya marcado 'en_curso' por el motor). */
  async originarAutomatica(campana: ParametrosCampana, lead: { id: number; telefono: string; lista_id: number }, gateway: GatewayVivo): Promise<void> {
    await this.originar({
      origen: campana.tipo === 'ivr' ? 'ivr' : 'discador',
      campana, leadId: lead.id, listaId: lead.lista_id, telefono: lead.telefono, gateway, vendedorId: null,
    });
  }

  /** Llamada manual desde el puesto. Devuelve el id de la llamada. */
  async llamarManual(usuarioId: number, telefono: string, leadId?: number): Promise<number> {
    const p = this.puestos.get(usuarioId);
    if (!p) throw new ErrorPuesto('Primero conectá tu línea (marcá 9000 desde el teléfono)');
    if (!p.puedeManual) throw new ErrorPuesto('No tenés permiso para marcar a mano');
    if (p.estado === 'en_llamada') throw new ErrorPuesto('Ya estás en una llamada');
    if (p.estado === 'tipificando' && this.config['tipificacion.obligatoria']) throw new ErrorPuesto('Tipificá la llamada anterior');

    const fuera = motivoFueraDeHorario(this.reglas, momentoEn(this.config['general.zona_horaria']));
    if (fuera) throw new ErrorPuesto(`No se puede llamar: ${fuera}`);
    if (await estaBloqueado(this.db, telefono)) throw new ErrorPuesto('El número está en No Llame');
    if (this.telefonoEnCurso(telefono)) throw new ErrorPuesto('Ese número ya está en una llamada');
    const gateway = this.elegirGateway(null, true);
    if (!gateway) throw new ErrorPuesto('No hay canales libres en los gateways');

    let campana: ParametrosCampana | null = null;
    let listaId: number | null = null;
    if (leadId) {
      const { rows } = await this.db.query<{ campana_id: number; lista_id: number; telefono: string }>(
        'SELECT campana_id, lista_id, telefono FROM leads WHERE id = $1',
        [leadId],
      );
      if (!rows[0] || rows[0].telefono !== telefono) throw new ErrorPuesto('El contacto no coincide con el número');
      listaId = rows[0].lista_id;
      campana = await cargarParametrosCampana(this.db, rows[0].campana_id);
    }

    this.cambiarPuesto(p, 'en_llamada');
    try {
      return await this.originar({ origen: 'manual', campana, leadId: leadId ?? null, listaId, telefono, gateway, vendedorId: usuarioId });
    } catch (err) {
      this.cambiarPuesto(p, 'disponible');
      throw err;
    }
  }

  /**
   * "Probar llamada" de una campaña IVR con aviso: su flujo completo hacia un número, con el audio
   * A o el B (no mueve el reparto de la campaña). Devuelve el id de la llamada.
   */
  async probarIvr(campanaId: number, telefono: string, cualAudio: 'a' | 'b' = 'a'): Promise<number> {
    const fuera = motivoFueraDeHorario(this.reglas, momentoEn(this.config['general.zona_horaria']));
    if (fuera) throw new ErrorPuesto(`No se puede llamar: ${fuera}`);
    if (await estaBloqueado(this.db, telefono)) throw new ErrorPuesto('El número está en No Llame');
    if (this.telefonoEnCurso(telefono)) throw new ErrorPuesto('Ese número ya está en una llamada');

    const campana = await cargarParametrosCampana(this.db, campanaId);
    if (!campana || campana.tipo !== 'ivr' || campana.ivr_destino !== 'aviso') {
      throw new ErrorPuesto('Solo se pueden probar las campañas IVR con aviso');
    }
    if (!campana.audio_id || !campana.audio_archivo) throw new ErrorPuesto('La campaña no tiene audio');
    if (cualAudio === 'b' && (!campana.audio_b_id || !campana.audio_b_archivo)) throw new ErrorPuesto('La campaña no tiene audio B');
    const audio: AudioMensaje = cualAudio === 'b'
      ? { id: campana.audio_b_id!, archivo: campana.audio_b_archivo! }
      : { id: campana.audio_id, archivo: campana.audio_archivo };
    const { rows } = await this.db.query<{ todos: boolean; gateways: number[] | null }>(
      `SELECT c.todos_los_gateways AS todos,
              (SELECT array_agg(cg.gateway_id) FROM campana_gateways cg WHERE cg.campana_id = c.id) AS gateways
         FROM campanas c WHERE c.id = $1`,
      [campanaId],
    );
    const permitidos = rows[0]?.todos ? null : (rows[0]?.gateways ?? []);
    // Como una manual: puede usar los canales reservados, así se prueba aunque la campaña esté marcando
    const gateway = this.elegirGateway(permitidos, true);
    if (!gateway) throw new ErrorPuesto('No hay canales libres en los gateways de la campaña');

    return this.originar({ origen: 'prueba', campana, leadId: null, listaId: null, telefono, gateway, vendedorId: null, audio });
  }

  private async originar(o: {
    origen: Llamada['origen']; campana: ParametrosCampana | null; leadId: number | null; listaId: number | null;
    telefono: string; gateway: GatewayVivo; vendedorId: number | null; audio?: AudioMensaje;
  }): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO llamadas (lead_id, campana_id, lista_id, gateway_id, vendedor_id, origen, tipo_campana, telefono)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      // La prueba se guarda sin campaña: no cuenta en los reportes de la campaña
      [o.leadId, o.origen === 'prueba' ? null : (o.campana?.id ?? null), o.listaId, o.gateway.id, o.vendedorId, o.origen, o.campana?.tipo ?? null, o.telefono],
    );
    const id = Number(rows[0]!.id);
    const canalId = `ll-${id}`;
    const ll: Llamada = {
      id, canalId, origen: o.origen, campana: o.campana, leadId: o.leadId, telefono: o.telefono, gatewayId: o.gateway.id,
      fase: 'marcando', inicio: Date.now(), contestada: false, conectada: false, vendedorId: o.vendedorId,
      enDialplan: false, repeticionesRestantes: 0, audio: o.audio, terminada: false,
    };
    this.llamadas.set(id, ll);
    this.porCanal.set(canalId, id);
    const uso = this.usoDe(o.gateway.id);
    uso.total++;
    if (esAutomatica(o.origen)) uso.auto++;
    uso.disparos.push(Date.now());
    if (uso.disparos.length > 500) uso.disparos.splice(0, uso.disparos.length - 500);
    if (o.campana && o.origen !== 'prueba') this.estadisticaDe(o.campana.id).intentos.push(Date.now());
    if (o.vendedorId) {
      const p = this.puestos.get(o.vendedorId);
      if (p) p.llamadaId = id;
    }
    await this.db.query('UPDATE llamadas SET canal_id = $2 WHERE id = $1', [id, canalId]);

    try {
      if (o.origen === 'manual') {
        // Manual: se crea el canal, se mete en el bridge del vendedor y recién ahí se marca
        // (alEntrarManualTemprano). Así el vendedor escucha el audio de la red mientras suena.
        await this.ari.crearCanal({ endpoint: `PJSIP/${o.telefono}@${o.gateway.endpoint}`, canalId, appArgs: 'manual-temprano' });
      } else {
        await this.ari.originar({
          endpoint: `PJSIP/${o.telefono}@${o.gateway.endpoint}`,
          canalId,
          appArgs: 'saliente',
          timeoutSeg: o.campana?.segundos_timbre ?? 40,
        });
      }
      await this.ari.suscribir(`channel:${canalId}`).catch(() => {});
    } catch (err) {
      this.log.warn({ err, llamada: id }, 'No se pudo originar');
      await this.terminar(ll, 'fallida', 'sistema');
    }
    this.emit('cambio');
    return id;
  }

  // =====================================================================
  //  Eventos de ARI
  // =====================================================================

  private async alEntrarEnStasis(e: AriEvento): Promise<void> {
    const canal = e.channel as { id: string };
    const args = (e.args as string[]) ?? [];
    const ll = this.llamadaPorCanal(canal.id);

    switch (args[0]) {
      case 'saliente':
        if (!ll) return void (await this.ari.colgar(canal.id).catch(() => {}));
        return this.alContestar(ll);
      case 'manual-temprano':
        if (!ll) return void (await this.ari.colgar(canal.id).catch(() => {}));
        return this.alEntrarManualTemprano(ll);
      case 'amd':
        if (!ll) return void (await this.ari.colgar(canal.id).catch(() => {}));
        ll.enDialplan = false;
        return this.alTerminarAmd(ll, args[1] ?? 'NOTSURE', args[2] ?? '');
      case 'linea':
        await this.conectarLinea(canal.id, args[1] ?? '', false);
        return;
      case 'manual':
        return this.manualDesdeSoftphone(canal.id, args[1] ?? '', args[2] ?? '');
      case 'espia':
        return this.alEntrarEspia(canal.id, Number(args[1]));
      default:
        await this.ari.colgar(canal.id).catch(() => {});
    }
  }

  /** Canal manual recién creado (sin marcar): al bridge del vendedor y después se marca. */
  private async alEntrarManualTemprano(ll: Llamada): Promise<void> {
    const p = ll.vendedorId ? this.puestos.get(ll.vendedorId) : undefined;
    if (!p || ll.terminada) return this.colgarYTerminar(ll, 'fallida', 'vendedor');
    try {
      await this.ari.agregarABridge(p.bridgeId, ll.canalId);
      ll.enBridgeTemprano = true;
    } catch (err) {
      // Si no se pudo meter en el bridge, igual se marca: se conecta al atender, con el tono sintético
      this.log.warn({ err, llamada: ll.id }, 'No se pudo poner la llamada manual en el bridge antes de marcar');
    }
    const timbre = ll.campana?.segundos_timbre ?? 40;
    try {
      await this.ari.marcar(ll.canalId, timbre);
      // Por si al vencer el timbre el canal no se cierra solo
      this.programar(ll, (timbre + 3) * 1000, async () => {
        if (!ll.contestada && !ll.terminada) await this.colgarYTerminar(ll, 'no_contesta', 'sistema');
      });
    } catch (err) {
      this.log.warn({ err, llamada: ll.id }, 'No se pudo marcar');
      await this.colgarYTerminar(ll, 'fallida', 'sistema');
    }
  }

  /**
   * Cambios de estado de un canal manual creado con crearCanal: 'Up' = atendió. 'Ringing' (180,
   * la red avisa que suena pero sin mandar audio) = se pone el tono sintético en la línea del
   * vendedor; con 183 + audio (lo normal en el Dinstar) el vendedor ya escucha la red.
   */
  private async alCambiarEstadoCanal(e: AriEvento): Promise<void> {
    const canal = e.channel as { id: string; state: string };
    const ll = this.llamadaPorCanal(canal.id);
    if (!ll || ll.terminada || ll.origen !== 'manual') return;
    if (canal.state === 'Up' && !ll.contestada) return this.alContestar(ll);
    if (canal.state === 'Ringing' && !ll.contestada && !ll.tonoLlamada) {
      const p = ll.vendedorId ? this.puestos.get(ll.vendedorId) : undefined;
      if (!p) return;
      ll.tonoLlamada = `tono-${ll.id}`;
      const tono = ll.tonoLlamada;
      await this.ari.reproducir(p.canalLinea, TONO_LLAMADA, tono).catch(() => {
        ll.tonoLlamada = undefined;
      });
      if (ll.contestada || ll.terminada) await this.ari.detenerReproduccion(tono).catch(() => {});
    }
  }

  private async cortarTonoLlamada(ll: Llamada): Promise<void> {
    if (!ll.tonoLlamada) return;
    const id = ll.tonoLlamada;
    ll.tonoLlamada = undefined;
    await this.ari.detenerReproduccion(id).catch(() => {});
  }

  private async alContestar(ll: Llamada): Promise<void> {
    ll.contestada = true;
    await this.cortarTonoLlamada(ll);
    await this.db.query('UPDATE llamadas SET contestada_en = now() WHERE id = $1', [ll.id]);

    if (ll.origen === 'manual') {
      const p = ll.vendedorId ? this.puestos.get(ll.vendedorId) : undefined;
      if (!p) return this.colgarYTerminar(ll, 'atendida', 'vendedor');
      return this.conectar(ll, p);
    }
    if (ll.campana?.amd_activo) {
      ll.fase = 'amd';
      ll.enDialplan = true;
      const c = this.config;
      const params = [
        c['amd.silencio_inicial_ms'], c['amd.saludo_max_ms'], c['amd.silencio_tras_saludo_ms'], c['amd.tiempo_total_ms'],
        c['amd.palabra_min_ms'], c['amd.silencio_entre_palabras_ms'], c['amd.palabras_maquina'], c['amd.umbral_silencio'],
        c['amd.palabra_max_ms'],
      ].join(',');
      await this.ari.definirVariable(ll.canalId, 'AMD_PARAMS', params);
      if (c['amd.grabar_deteccion']) {
        ll.grabacionAmd = `amd-${ll.id}`;
        await this.ari.definirVariable(ll.canalId, 'AMD_GRABAR', `${config.DIR_GRABACIONES}/${ll.grabacionAmd}.wav`).catch(() => {
          ll.grabacionAmd = undefined;
        });
      }
      await this.ari.continuarEnDialplan(ll.canalId, 'amd');
      // Si el canal muere dentro del dialplan sin volver, igual se cierra la llamada
      this.programar(ll, c['amd.tiempo_total_ms'] + MARGEN_AMD_MS, async () => {
        if (ll.fase === 'amd' && !ll.terminada) await this.colgarYTerminar(ll, 'atendida', 'sistema');
      });
      this.emit('cambio');
      return;
    }
    return this.despuesDeAmd(ll);
  }

  private async alTerminarAmd(ll: Llamada, estado: string, causa: string): Promise<void> {
    this.limpiarTemporizador(ll);
    ll.amdEstado = ['HUMAN', 'MACHINE', 'NOTSURE', 'HANGUP'].includes(estado) ? estado : 'NOTSURE';
    ll.amdCausa = causa;
    if (ll.amdEstado === 'MACHINE' || (ll.amdEstado === 'NOTSURE' && !this.config['amd.pasar_dudosas'])) {
      return this.colgarYTerminar(ll, 'contestador', 'sistema');
    }
    if (ll.amdEstado === 'HANGUP') return this.colgarYTerminar(ll, 'atendida', 'cliente');
    return this.despuesDeAmd(ll);
  }

  private async despuesDeAmd(ll: Llamada): Promise<void> {
    const c = ll.campana;
    if (c?.audio_archivo && (c.tipo === 'predictivo_audio' || c.tipo === 'ivr')) {
      ll.fase = 'audio';
      ll.repeticionesRestantes = c.ivr_repeticiones;
      ll.audio ??= this.elegirAudio(c);
      await this.reproducirAudio(ll);
      await this.db.query('UPDATE llamadas SET audio_inicio_en = now(), audio_id = $2 WHERE id = $1', [ll.id, ll.audio.id]);
      this.emit('cambio');
      return;
    }
    return this.pasarACola(ll);
  }

  /**
   * Audio A o B según el % de la campaña, alternando parejo en lugar de al azar: se suma el % del B
   * en cada llamada y sale el B cada vez que se juntan 100. Con 30 %, de cada 10 llamadas la 4.ª,
   * la 7.ª y la 10.ª escuchan el B; así los dos audios caen en las mismas horas y la misma base.
   */
  private elegirAudio(c: ParametrosCampana): AudioMensaje {
    const a: AudioMensaje = { id: c.audio_id!, archivo: c.audio_archivo! };
    if (!c.audio_b_id || !c.audio_b_archivo || c.audio_b_pct <= 0) return a;
    const b: AudioMensaje = { id: c.audio_b_id, archivo: c.audio_b_archivo };
    if (c.audio_b_pct >= 100) return b;
    const clave = `${c.audio_id}/${c.audio_b_id}/${c.audio_b_pct}`;
    let r = this.repartoAudios.get(c.id);
    if (r?.clave !== clave) {
      r = { clave, acumulado: 0 };
      this.repartoAudios.set(c.id, r);
    }
    r.acumulado += c.audio_b_pct;
    if (r.acumulado < 100) return a;
    r.acumulado -= 100;
    return b;
  }

  private async reproducirAudio(ll: Llamada): Promise<void> {
    const playbackId = `pb-${ll.id}-${ll.repeticionesRestantes}`;
    ll.reproduciendo = playbackId;
    await this.ari.reproducir(ll.canalId, `sound:campanas/${ll.audio!.archivo}`, playbackId);
  }

  private async alTerminarAudio(e: AriEvento): Promise<void> {
    const playback = e.playback as { id: string };
    const m = /^pb-(\d+)-/.exec(playback.id);
    const ll = m ? this.llamadas.get(Number(m[1])) : undefined;
    if (!ll || ll.reproduciendo !== playback.id) return;
    if (ll.fase === 'despedida') {
      ll.reproduciendo = undefined;
      return this.colgarYTerminar(ll, 'aviso_ivr', 'sistema');
    }
    if (ll.fase !== 'audio') return;
    // Si el cliente corta, Asterisk avisa el fin del audio justo antes de destruir el canal:
    // se espera un instante para no confundir un corte con un audio escuchado entero
    await new Promise((r) => setTimeout(r, 250));
    if (ll.terminada || ll.reproduciendo !== playback.id) return;
    ll.reproduciendo = undefined;
    ll.repeticionesRestantes--;
    if (ll.repeticionesRestantes > 0) return this.reproducirAudio(ll);

    await this.db.query('UPDATE llamadas SET audio_fin_en = now() WHERE id = $1', [ll.id]);
    const c = ll.campana!;
    if (c.ivr_modo === 'presione_1' || c.ivr_destino === 'aviso') {
      ll.fase = 'espera_tecla';
      this.programar(ll, c.ivr_espera_seg * 1000, () => this.colgarYTerminar(ll, 'sin_confirmar', 'sistema'));
    } else {
      ll.fase = 'permanencia';
      this.programar(ll, c.ivr_espera_seg * 1000, () => this.pasarACola(ll));
    }
    this.emit('cambio');
  }

  private async alRecibirTecla(e: AriEvento): Promise<void> {
    const ll = this.llamadaPorCanal((e.channel as { id: string }).id);
    const tecla = String(e.digit ?? '');
    if (!ll?.campana || !['audio', 'espera_tecla', 'permanencia'].includes(ll.fase)) return;
    const c = ll.campana;

    if (c.ivr_tecla_no_llame && tecla === c.ivr_tecla_no_llame) {
      ll.tecla = tecla;
      await bloquearNumero(this.db, { telefono: ll.telefono, fuente: 'ivr', llamadaId: ll.id, motivo: `tecla ${tecla} en el IVR` });
      return this.colgarYTerminar(ll, 'no_llame_ivr', 'cliente');
    }
    if (c.ivr_destino === 'aviso') {
      const contacto = tecla === c.ivr_tecla_llamada ? 'llamada' : tecla === c.ivr_tecla_whatsapp ? 'whatsapp' : null;
      // Solo la primera tecla: dos seguidas (1 y 2 casi juntas) no tienen que dar dos avisos
      if (contacto && !ll.tecla) await this.registrarAviso(ll, contacto, tecla);
      return;
    }
    if (tecla === c.ivr_tecla_pase && (c.ivr_modo === 'presione_1' || c.ivr_modo === 'cualquiera')) {
      ll.tecla = tecla;
      if (ll.reproduciendo) {
        const pb = ll.reproduciendo;
        ll.reproduciendo = undefined;
        await this.ari.detenerReproduccion(pb).catch(() => {});
        await this.db.query('UPDATE llamadas SET audio_fin_en = now() WHERE id = $1', [ll.id]);
      }
      return this.pasarACola(ll);
    }
  }

  /** IVR con aviso: el cliente eligió cómo quiere que lo contacten. Despedida (si hay) y se corta. */
  private async registrarAviso(ll: Llamada, contacto: AvisoIvr['contacto'], tecla: string): Promise<void> {
    const c = ll.campana!;
    this.limpiarTemporizador(ll);
    ll.tecla = tecla;
    if (ll.reproduciendo) {
      const pb = ll.reproduciendo;
      ll.reproduciendo = undefined;
      await this.ari.detenerReproduccion(pb).catch(() => {});
    }
    await this.db.query('UPDATE llamadas SET audio_fin_en = coalesce(audio_fin_en, now()) WHERE id = $1', [ll.id]);
    // En la prueba la tecla queda solo en la llamada: no hay aviso para los vendedores
    if (ll.origen !== 'prueba') {
      this.estadisticaDe(c.id).humanos.push(Date.now());
      this.emit('aviso_ivr', {
        llamadaId: ll.id, campanaId: c.id, leadId: ll.leadId, telefono: ll.telefono, contacto, tecla,
      } satisfies AvisoIvr);
    }
    if (!c.audio_despedida_archivo) return this.colgarYTerminar(ll, 'aviso_ivr', 'sistema');
    ll.fase = 'despedida';
    const playbackId = `pb-${ll.id}-despedida`;
    ll.reproduciendo = playbackId;
    try {
      await this.ari.reproducir(ll.canalId, `sound:campanas/${c.audio_despedida_archivo}`, playbackId);
    } catch {
      return this.colgarYTerminar(ll, 'aviso_ivr', 'sistema');
    }
    // Por si nunca llega el fin del audio
    this.programar(ll, 60_000, () => this.colgarYTerminar(ll, 'aviso_ivr', 'sistema'));
    this.emit('cambio');
  }

  /**
   * Un interno que pierde el registro con la línea abierta (se cerró o colgó el navegador, se
   * cortó la red): la línea quedó muerta y el cliente le estaría hablando a nadie. Se corta.
   * Si la PC entera desaparece, sin BYE ni cierre del WebSocket, lo detecta Asterisk por falta
   * de audio (rtp_timeout en pjsip.conf).
   */
  private async alCambiarEndpoint(e: AriEvento): Promise<void> {
    const ep = e.endpoint as { technology: string; resource: string; state: string };
    if (ep.technology !== 'PJSIP' || ep.state !== 'offline') return;
    for (const p of this.puestos.values()) {
      if (p.interno === ep.resource) {
        this.log.warn({ interno: p.interno, usuario: p.usuarioId }, 'El interno perdió el registro con la línea abierta: se corta');
        return this.desconectarLinea(p);
      }
    }
  }

  private async alDestruirseCanal(e: AriEvento): Promise<void> {
    const canal = e.channel as { id: string };
    const causa = Number(e.cause ?? 0);
    const ll = this.llamadaPorCanal(canal.id);
    if (ll && !ll.terminada) {
      let resultado: Resultado;
      if (!ll.contestada) resultado = causa === 17 ? 'ocupado' : CAUSAS_FALLA.has(causa) ? 'fallida' : 'no_contesta';
      else if (ll.fase === 'conversacion') resultado = 'atendida';
      else if (ll.fase === 'cola') resultado = 'abandonada';
      else if (ll.fase === 'amd') resultado = 'atendida';
      else if (ll.fase === 'despedida') resultado = 'aviso_ivr';
      else resultado = 'corto_en_mensaje';
      if (ll.fase === 'cola' && ll.campana?.tipo === 'ivr') await this.derivar(ll, 'corto_en_cola');
      return this.terminar(ll, resultado, ll.colgo ?? 'cliente', causa);
    }

    for (const p of this.puestos.values()) {
      if (p.canalLinea === canal.id) return this.desconectarLinea(p);
      if (p.espia?.canalId === canal.id && p.espia.modo !== 'intervenir') {
        const vendedor = this.puestos.get(p.espia.vendedorId);
        p.espia = undefined;
        if (vendedor) await this.vigilarLinea(vendedor.canalLinea);
      }
    }
  }

  // =====================================================================
  //  Cola y conexión con el vendedor
  // =====================================================================

  private async pasarACola(ll: Llamada): Promise<void> {
    if (ll.terminada) return;
    this.limpiarTemporizador(ll);
    ll.fase = 'cola';
    ll.enColaDesde = Date.now();
    if (ll.campana) this.estadisticaDe(ll.campana.id).humanos.push(Date.now());
    await this.db.query('UPDATE llamadas SET en_cola_en = now() WHERE id = $1', [ll.id]);
    await this.ari.musicaEnEspera(ll.canalId, true).catch(() => {});
    const espera = (ll.campana?.espera_max_seg ?? 20) * 1000;
    this.programar(ll, espera, () => this.abandonar(ll));
    await this.asignar();
    this.emit('cambio');
  }

  private async abandonar(ll: Llamada): Promise<void> {
    if (ll.fase !== 'cola' || ll.terminada) return;
    if (ll.campana?.tipo === 'ivr') {
      await this.derivar(ll, ll.campana.espera_max_seg === 0 ? 'sin_vendedor_libre' : 'espera_vencida');
    }
    await this.colgarYTerminar(ll, 'abandonada', 'sistema');
  }

  /** Reparte las llamadas en cola entre los vendedores libres. */
  async asignar(): Promise<void> {
    const prioridadIvr = this.config?.['ivr.prioridad_en_cola'] ?? true;
    const enCola = [...this.llamadas.values()]
      .filter((l) => l.fase === 'cola' && !l.terminada)
      .sort((a, b) => {
        if (prioridadIvr) {
          const ivr = Number(b.campana?.tipo === 'ivr') - Number(a.campana?.tipo === 'ivr');
          if (ivr) return ivr;
        }
        return (b.campana?.prioridad ?? 0) - (a.campana?.prioridad ?? 0) || a.enColaDesde! - b.enColaDesde!;
      });
    for (const ll of enCola) {
      const libre = ll.campana
        ? this.libresPara(ll.campana).sort((a, b) => a.libreDesde - b.libreDesde)[0]
        : undefined;
      if (libre) await this.conectar(ll, libre);
    }
  }

  private async conectar(ll: Llamada, p: Puesto): Promise<void> {
    this.limpiarTemporizador(ll);
    if (ll.fase === 'cola') await this.ari.musicaEnEspera(ll.canalId, false).catch(() => {});
    ll.fase = 'conversacion';
    ll.conectada = true;
    ll.vendedorId = p.usuarioId;
    p.llamadaId = ll.id;
    p.ultimaLlamadaId = ll.id;
    if (p.estado !== 'en_llamada') this.cambiarPuesto(p, 'en_llamada');

    try {
      if (!ll.enBridgeTemprano) await this.ari.agregarABridge(p.bridgeId, ll.canalId);
    } catch (err) {
      this.log.error({ err, llamada: ll.id }, 'No se pudo conectar con el vendedor');
      return this.colgarYTerminar(ll, 'atendida', 'sistema');
    }
    if (ll.campana?.grabar ?? true) {
      ll.grabacion = `llamada-${ll.id}`;
      await this.ari.grabarBridge(p.bridgeId, ll.grabacion).catch((err: unknown) => {
        this.log.warn({ err, llamada: ll.id }, 'No se pudo iniciar la grabación');
        ll.grabacion = undefined;
      });
    }
    if (ll.campana) this.estadisticaDe(ll.campana.id).conectadas.push(Date.now());
    await this.db.query(
      'UPDATE llamadas SET conectada_vendedor_en = now(), vendedor_id = $2, grabacion_path = $3 WHERE id = $1',
      [ll.id, p.usuarioId, ll.grabacion ?? null],
    );
    this.emit('puesto', p.usuarioId, { tipo: 'llamada_conectada', ficha: await this.ficha(ll) });
    this.emit('cambio');
  }

  private async ficha(ll: Llamada) {
    const { rows } = ll.leadId
      ? await this.db.query('SELECT id, nombre, telefono, dni, datos, intentos, ultimo_resultado FROM leads WHERE id = $1', [ll.leadId])
      : { rows: [] };
    return {
      llamada_id: ll.id, telefono: ll.telefono, origen: ll.origen,
      campana: ll.campana ? { id: ll.campana.id, nombre: ll.campana.nombre, tipo: ll.campana.tipo } : null,
      lead: rows[0] ?? null, tecla_ivr: ll.tecla ?? null,
    };
  }

  // =====================================================================
  //  Fin de la llamada
  // =====================================================================

  private async colgarYTerminar(ll: Llamada, resultado: Resultado, colgo: QuienColgo): Promise<void> {
    ll.colgo = colgo;
    await this.terminar(ll, resultado, colgo);
    await this.ari.colgar(ll.canalId).catch(() => {});
  }

  private async terminar(ll: Llamada, resultado: Resultado, colgo: QuienColgo, causa?: number): Promise<void> {
    if (ll.terminada) return;
    ll.terminada = true;
    this.limpiarTemporizador(ll);
    await this.cortarTonoLlamada(ll);
    this.llamadas.delete(ll.id);
    this.porCanal.delete(ll.canalId);
    const uso = this.usoDe(ll.gatewayId);
    uso.total = Math.max(0, uso.total - 1);
    if (esAutomatica(ll.origen)) uso.auto = Math.max(0, uso.auto - 1);
    if (resultado === 'abandonada' && ll.campana) this.estadisticaDe(ll.campana.id).abandonos.push(Date.now());
    if (ll.grabacion) await this.ari.detenerGrabacion(ll.grabacion).catch(() => {});

    await this.db.query(
      `UPDATE llamadas SET fin = now(), resultado = $2, amd_estado = $3, amd_causa = $4, tecla_ivr = $5,
              causa_sip = $6, colgo = $7, amd_grabacion_path = $8 WHERE id = $1`,
      [ll.id, resultado, ll.amdEstado ?? null, ll.amdCausa ?? null, ll.tecla ?? null, causa ?? null, colgo, ll.grabacionAmd ?? null],
    );
    await this.actualizarLead(ll, resultado);

    const p = ll.vendedorId ? this.puestos.get(ll.vendedorId) : undefined;
    if (p && p.llamadaId === ll.id) {
      p.llamadaId = null;
      const tipificar = ll.conectada && this.config['tipificacion.obligatoria'];
      this.cambiarPuesto(p, tipificar ? 'tipificando' : 'disponible');
      this.emit('puesto', p.usuarioId, {
        tipo: 'llamada_terminada', llamada_id: ll.id, resultado, conectada: ll.conectada, debe_tipificar: tipificar,
      });
      if (p.lineaTemporal) await this.ari.colgar(p.canalLinea).catch(() => {});
    }
    this.emit('cambio');
    await this.asignar();
  }

  private async actualizarLead(ll: Llamada, resultado: Resultado): Promise<void> {
    if (!ll.leadId || !ll.campana) return;
    // Si llegó al vendedor queda en 'reintentar' provisorio: la tipificación decide si se cierra
    await this.db.query(
      `UPDATE leads SET intentos = intentos + 1, ultimo_resultado = $2, ultima_llamada_en = now(),
              estado = CASE WHEN $3 THEN 'no_llamar'
                            WHEN $2 = 'aviso_ivr' THEN 'finalizado' -- ya eligió cómo contactarlo: no se vuelve a marcar
                            WHEN NOT $4 AND intentos + 1 >= $5 THEN 'agotado'
                            ELSE 'reintentar' END,
              proximo_intento = now() + make_interval(mins => $6)
        WHERE id = $1`,
      [ll.leadId, resultado, resultado === 'no_llame_ivr', ll.conectada, ll.campana.max_intentos, ll.campana.minutos_reintento],
    );
  }

  private async derivar(ll: Llamada, motivo: 'sin_vendedor_libre' | 'espera_vencida' | 'corto_en_cola'): Promise<void> {
    await this.db.query(
      'INSERT INTO derivaciones (llamada_id, campana_id, lead_id, telefono, motivo) VALUES ($1, $2, $3, $4, $5)',
      [ll.id, ll.campana?.id ?? null, ll.leadId, ll.telefono, motivo],
    );
  }

  // =====================================================================
  //  Acciones del vendedor
  // =====================================================================

  async colgarDesdePuesto(usuarioId: number): Promise<void> {
    const p = this.puestos.get(usuarioId);
    const ll = p?.llamadaId ? this.llamadas.get(p.llamadaId) : undefined;
    if (!ll) throw new ErrorPuesto('No estás en una llamada');
    ll.colgo = 'vendedor';
    await this.ari.colgar(ll.canalId).catch(() => {});
    // Si todavía no contestaron, el ChannelDestroyed cierra la llamada como no_contesta
  }

  async cambiarEstado(usuarioId: number, estado: 'disponible' | 'descanso', motivoDescansoId?: number): Promise<void> {
    const p = this.puestos.get(usuarioId);
    if (!p) throw new ErrorPuesto('Primero conectá tu línea (marcá 9000 desde el teléfono)');
    if (p.estado === 'en_llamada') throw new ErrorPuesto('Estás en una llamada');
    if (p.estado === 'tipificando' && this.config['tipificacion.obligatoria']) throw new ErrorPuesto('Tipificá la llamada anterior');
    if (estado === 'descanso' && !motivoDescansoId) throw new ErrorPuesto('Elegí el motivo del descanso');
    this.cambiarPuesto(p, estado, estado === 'descanso' ? motivoDescansoId! : null);
    if (estado === 'disponible') await this.asignar();
  }

  /** Tipifica una llamada del vendedor (la recién terminada o una pendiente). */
  async tipificar(usuarioId: number, t: { llamadaId: number; tipificacionId: number; notas?: string; reintentarEnMin?: number }): Promise<void> {
    const { rows } = await this.db.query<{
      lead_id: number | null; minutos_reintento: number | null; es_final: boolean; reintentar_en_min: number | null;
      marca_no_llame: boolean; es_contestador: boolean; telefono: string; fin: Date | null;
    }>(
      `SELECT l.lead_id, c.minutos_reintento, t.es_final, t.reintentar_en_min, t.marca_no_llame, t.es_contestador, l.telefono, l.fin
         FROM llamadas l
         JOIN tipificaciones t ON t.id = $3 AND t.activa
         LEFT JOIN campanas c ON c.id = l.campana_id
        WHERE l.id = $1 AND l.vendedor_id = $2 AND l.conectada_vendedor_en IS NOT NULL`,
      [t.llamadaId, usuarioId, t.tipificacionId],
    );
    const r = rows[0];
    if (!r) throw new ErrorPuesto('Llamada o tipificación inválida');
    if (!r.fin) throw new ErrorPuesto('La llamada todavía está en curso');

    await this.db.query('UPDATE llamadas SET tipificacion_id = $2, tipificada_en = now(), notas = $3 WHERE id = $1', [
      t.llamadaId, t.tipificacionId, t.notas ?? null,
    ]);
    // El vendedor dice que era un contestador: el AMD se equivocó al dejarlo pasar
    if (r.es_contestador) {
      await this.db.query(
        `UPDATE llamadas SET amd_revision = 'error', amd_revisado_por = $2, amd_revisado_en = now()
          WHERE id = $1 AND amd_estado IS NOT NULL AND amd_revision IS NULL`,
        [t.llamadaId, usuarioId],
      );
    }
    if (r.marca_no_llame) {
      await bloquearNumero(this.db, { telefono: r.telefono, fuente: 'vendedor', usuarioId, llamadaId: t.llamadaId });
    }
    if (r.lead_id && !r.marca_no_llame) {
      const minutos = t.reintentarEnMin ?? r.reintentar_en_min ?? r.minutos_reintento ?? 60;
      await this.db.query(
        `UPDATE leads SET estado = CASE WHEN $2 THEN 'finalizado' ELSE 'reintentar' END,
                proximo_intento = CASE WHEN $2 THEN proximo_intento ELSE now() + make_interval(mins => $3) END
          WHERE id = $1 AND estado <> 'no_llamar'`,
        [r.lead_id, r.es_final, minutos],
      );
    }
    const p = this.puestos.get(usuarioId);
    if (p?.estado === 'tipificando' && p.ultimaLlamadaId === t.llamadaId) {
      this.cambiarPuesto(p, 'disponible');
      await this.asignar();
    }
  }

  // =====================================================================
  //  Líneas (vendedores y supervisores)
  // =====================================================================

  private async conectarLinea(canalId: string, interno: string, temporal: boolean): Promise<Puesto | undefined> {
    const { rows } = await this.db.query<{
      id: number; nombre: string; rol: Puesto['rol']; recibe_ivr: boolean; puede_marcar_manual: boolean; tope_llamadas: number | null;
    }>(
      `SELECT id, nombre, rol, recibe_ivr, puede_marcar_manual, tope_llamadas::float8 AS tope_llamadas
         FROM usuarios WHERE interno_sip = $1 AND activo`,
      [interno],
    );
    const u = rows[0];
    if (!u) {
      await this.ari.colgar(canalId).catch(() => {});
      return;
    }
    const anterior = this.puestos.get(u.id);
    if (anterior) await this.desconectarLinea(anterior);

    await this.ari.atender(canalId);
    const bridge = await this.ari.crearBridge('mixing');
    await this.ari.agregarABridge(bridge.id, canalId);
    await this.vigilarLinea(canalId);
    await this.ari.suscribir(`endpoint:PJSIP/${interno}`).catch(() => {});
    const ahora = Date.now();
    const p: Puesto = {
      usuarioId: u.id, nombre: u.nombre, interno, rol: u.rol, canalLinea: canalId, bridgeId: bridge.id,
      lineaTemporal: temporal, estado: 'disponible', motivoDescansoId: null, desde: ahora, libreDesde: ahora,
      llamadaId: null, ultimaLlamadaId: null, recibeIvr: u.recibe_ivr, puedeManual: u.puede_marcar_manual || u.rol === 'admin', tope: u.tope_llamadas,
    };
    this.puestos.set(u.id, p);
    await this.registrarEvento(u.id, 'login', null);
    if (!temporal && u.rol === 'vendedor') await this.registrarEvento(u.id, 'disponible', null);
    this.emit('puesto', u.id, { tipo: 'linea', conectada: true, estado: p.estado });
    this.emit('cambio');
    if (!temporal) await this.asignar();
    return p;
  }

  private async desconectarLinea(p: Puesto): Promise<void> {
    if (this.puestos.get(p.usuarioId) !== p) return;
    this.puestos.delete(p.usuarioId);
    const ll = p.llamadaId ? this.llamadas.get(p.llamadaId) : undefined;
    if (ll) {
      ll.colgo = 'vendedor';
      await this.ari.colgar(ll.canalId).catch(() => {});
    }
    if (p.espia) await this.dejarDeEscuchar(p).catch(() => {});
    await this.ari.colgar(p.canalLinea).catch(() => {});
    await this.ari.borrarBridge(p.bridgeId).catch(() => {});
    await this.registrarEvento(p.usuarioId, 'logout', null);
    this.emit('puesto', p.usuarioId, { tipo: 'linea', conectada: false });
    this.emit('cambio');
  }

  /** Softphone sin línea abierta que marca un número: se abre una línea temporal y se llama. */
  private async manualDesdeSoftphone(canalId: string, interno: string, numero: string): Promise<void> {
    const telefono = normalizarTelefono(numero);
    const { rows } = await this.db.query<{ id: number }>('SELECT id FROM usuarios WHERE interno_sip = $1 AND activo', [interno]);
    const existente = rows[0] ? this.puestos.get(rows[0].id) : undefined;
    if (!telefono || !rows[0] || existente) {
      // Con la línea abierta se marca desde el puesto, no desde el teléfono
      await this.ari.colgar(canalId).catch(() => {});
      return;
    }
    const p = await this.conectarLinea(canalId, interno, true);
    if (!p) return;
    try {
      await this.llamarManual(p.usuarioId, telefono);
    } catch (err) {
      this.log.info({ motivo: (err as Error).message, interno }, 'Llamada manual rechazada');
      await this.desconectarLinea(p);
    }
  }

  private cambiarPuesto(p: Puesto, estado: EstadoPuesto, motivoDescansoId: number | null = null): void {
    if (p.estado === estado && p.motivoDescansoId === motivoDescansoId) return;
    p.estado = estado;
    p.motivoDescansoId = motivoDescansoId;
    p.desde = Date.now();
    if (estado === 'disponible') p.libreDesde = p.desde;
    if (!p.lineaTemporal) void this.registrarEvento(p.usuarioId, estado, motivoDescansoId);
    this.emit('puesto', p.usuarioId, { tipo: 'estado', estado, motivo_descanso_id: motivoDescansoId });
    this.emit('cambio');
  }

  private async registrarEvento(usuarioId: number, estado: string, motivo: number | null): Promise<void> {
    await this.db
      .query('INSERT INTO vendedor_eventos (usuario_id, estado, motivo_descanso_id) VALUES ($1, $2, $3)', [usuarioId, estado, motivo])
      .catch((err: unknown) => this.log.error({ err }, 'No se pudo registrar el evento del vendedor'));
  }

  // =====================================================================
  //  Supervisión: escuchar / susurrar / intervenir
  // =====================================================================

  async escuchar(supervisorId: number, vendedorId: number, modo: 'escuchar' | 'susurrar' | 'intervenir'): Promise<void> {
    const sup = this.puestos.get(supervisorId);
    if (!sup) throw new ErrorPuesto('Primero conectá tu línea (marcá 9000 desde el teléfono)');
    const v = this.puestos.get(vendedorId);
    if (!v) throw new ErrorPuesto('El vendedor no tiene la línea conectada');
    if (supervisorId === vendedorId) throw new ErrorPuesto('No podés escucharte a vos mismo');
    if (sup.espia) await this.dejarDeEscuchar(sup);

    if (modo === 'intervenir') {
      await this.ari.quitarDeBridge(sup.bridgeId, sup.canalLinea);
      await this.ari.agregarABridge(v.bridgeId, sup.canalLinea);
      sup.espia = { modo, vendedorId, canalId: sup.canalLinea };
    } else {
      // 'out' = hacia el vendedor: en susurrar, solo el vendedor escucha al supervisor
      const espia = await this.ari.espiar(v.canalLinea, 'both', modo === 'susurrar' ? 'out' : 'none', `espia,${supervisorId}`);
      sup.espia = { modo, vendedorId, canalId: espia.id };
    }
    this.emit('cambio');
  }

  /** "Probar audio" del puesto: 3 s de tono por la línea, el mismo camino que la voz del cliente. */
  async probarAudio(usuarioId: number): Promise<void> {
    const p = this.puestos.get(usuarioId);
    if (!p) throw new ErrorPuesto('Primero conectá tu línea');
    if (p.llamadaId) throw new ErrorPuesto('Estás en una llamada');
    const id = `prueba-audio-${usuarioId}-${Date.now()}`;
    await this.ari.reproducir(p.canalLinea, TONO_LLAMADA, id);
    setTimeout(() => void this.ari.detenerReproduccion(id).catch(() => {}), 3000);
  }

  async dejarDeEscuchar(sup: Puesto | number): Promise<void> {
    const p = typeof sup === 'number' ? this.puestos.get(sup) : sup;
    if (!p?.espia) return;
    const { modo, vendedorId, canalId } = p.espia;
    p.espia = undefined;
    if (modo === 'intervenir') {
      const v = this.puestos.get(vendedorId);
      if (v) await this.ari.quitarDeBridge(v.bridgeId, p.canalLinea).catch(() => {});
      await this.ari.agregarABridge(p.bridgeId, p.canalLinea).catch(() => {});
    } else {
      await this.ari.colgar(canalId).catch(() => {});
      const v = this.puestos.get(vendedorId);
      if (v) await this.vigilarLinea(v.canalLinea);
    }
    this.emit('cambio');
  }

  private async alEntrarEspia(canalId: string, supervisorId: number): Promise<void> {
    const sup = this.puestos.get(supervisorId);
    if (!sup || sup.espia?.canalId !== canalId) return void (await this.ari.colgar(canalId).catch(() => {}));
    await this.ari.agregarABridge(sup.bridgeId, canalId);
  }

  // =====================================================================
  //  Utilidades
  // =====================================================================

  /** Recarga los datos de los usuarios con línea abierta (permisos, IVR, tope); corta a los dados de baja. */
  async refrescarPuestos(): Promise<void> {
    if (this.puestos.size === 0) return;
    const { rows } = await this.db.query<{
      id: number; nombre: string; activo: boolean; recibe_ivr: boolean; puede_marcar_manual: boolean; tope_llamadas: number | null;
    }>(
      `SELECT id, nombre, activo, recibe_ivr, puede_marcar_manual, tope_llamadas::float8 AS tope_llamadas
         FROM usuarios WHERE id = ANY($1)`,
      [[...this.puestos.keys()]],
    );
    for (const u of rows) {
      const p = this.puestos.get(u.id)!;
      if (!u.activo) {
        await this.desconectarLinea(p);
        continue;
      }
      Object.assign(p, { nombre: u.nombre, recibeIvr: u.recibe_ivr, puedeManual: u.puede_marcar_manual || p.rol === 'admin', tope: u.tope_llamadas });
    }
    this.emit('cambio');
  }

  /**
   * Suscripción explícita a los eventos de la línea. Asterisk da de baja la suscripción de la
   * app al canal espiado cuando termina un snoop: sin esto, el corte de esa línea pasaría inadvertido.
   */
  private async vigilarLinea(canalId: string): Promise<void> {
    await this.ari.suscribir(`channel:${canalId}`).catch(() => {});
  }

  // =====================================================================
  //  Vigilante de canales
  // =====================================================================

  vigilancia = { ultima: 0, cortadas_total: 0, eventos: [] as { ts: number; detalle: string }[] };

  private anotarVigilancia(detalle: string): void {
    this.log.warn({ detalle }, 'Vigilante de canales');
    this.vigilancia.cortadas_total++;
    this.vigilancia.eventos.unshift({ ts: Date.now(), detalle });
    this.vigilancia.eventos.length = Math.min(this.vigilancia.eventos.length, 20);
  }

  /**
   * Compara lo que el conmutador cree que está en curso con los canales reales de Asterisk:
   * cierra las llamadas cuyo canal ya no existe (se perdió el evento), cuelga los canales de
   * llamadas que el conmutador ya no tiene, corta lo que supera la duración máxima y recuenta
   * los puertos en uso de cada gateway (así un evento perdido no deja un puerto "ocupado").
   */
  async vigilar(): Promise<void> {
    const canales = await this.ari.solicitud<{ id: string; name: string }[]>('GET', '/channels');
    const existentes = new Set(canales.map((c) => c.id));
    const ahora = Date.now();
    const maxMs = (this.config?.['llamadas.duracion_max_min'] ?? 60) * 60_000;

    for (const ll of [...this.llamadas.values()]) {
      if (ll.terminada) continue;
      if (!existentes.has(ll.canalId) && ahora - ll.inicio > MARGEN_VIGILANTE_MS) {
        this.anotarVigilancia(`Llamada ${ll.id} (${ll.telefono}) sin canal en Asterisk: se cierra`);
        const resultado: Resultado = !ll.contestada ? 'fallida' : ll.conectada ? 'atendida' : ll.fase === 'cola' ? 'abandonada' : 'corto_en_mensaje';
        await this.terminar(ll, resultado, ll.colgo ?? 'sistema');
      } else if (ahora - ll.inicio > maxMs) {
        this.anotarVigilancia(`Llamada ${ll.id} (${ll.telefono}) superó ${maxMs / 60_000} min: se corta`);
        await this.colgarYTerminar(ll, ll.contestada ? 'atendida' : 'fallida', 'sistema');
      }
    }
    // Canales del discador (ll-<id>) que ya no corresponden a ninguna llamada viva
    for (const c of canales) {
      if (c.id.startsWith('ll-') && !this.porCanal.has(c.id)) {
        this.anotarVigilancia(`Canal huérfano ${c.name}: se cuelga`);
        await this.ari.colgar(c.id).catch(() => {});
      }
    }
    // Líneas cuyo canal desapareció
    for (const p of [...this.puestos.values()]) {
      if (!existentes.has(p.canalLinea)) {
        this.anotarVigilancia(`La línea de ${p.nombre} ya no existe en Asterisk: se desconecta`);
        await this.desconectarLinea(p);
      }
    }
    // Recuento de puertos en uso desde las llamadas vivas
    for (const [gatewayId, uso] of this.enUso) {
      const vivas = [...this.llamadas.values()].filter((l) => l.gatewayId === gatewayId);
      uso.total = vivas.length;
      uso.auto = vivas.filter((l) => esAutomatica(l.origen)).length;
    }
    this.vigilancia.ultima = ahora;
  }

  /**
   * Al arrancar el proceso: cuelga los canales y borra los bridges que quedaron de una ejecución
   * anterior (el estado en memoria se perdió). Los softphones vuelven a abrir su línea solos.
   */
  async limpiarHuerfanos(): Promise<void> {
    const canales = await this.ari.solicitud<{ id: string; dialplan: { app_name: string; app_data: string } }[]>('GET', '/channels');
    for (const c of canales) {
      if (c.dialplan.app_name === 'Stasis' && c.dialplan.app_data.startsWith('discador')) await this.ari.colgar(c.id).catch(() => {});
    }
    const bridges = await this.ari.solicitud<{ id: string; creator: string }[]>('GET', '/bridges');
    for (const b of bridges) if (b.creator === 'Stasis') await this.ari.borrarBridge(b.id).catch(() => {});
  }

  private puedeAtender(p: Puesto, campana: { id: number; tipo: TipoCampana }): boolean {
    if (p.rol !== 'vendedor' || p.lineaTemporal) return false;
    if (campana.tipo === 'ivr' && !p.recibeIvr) return false;
    if (this.config?.['general.vendedor_solo_su_campana'] ?? true) {
      return this.asignaciones.get(campana.id)?.has(p.usuarioId) ?? false;
    }
    return true;
  }

  /** Tope de llamadas en el aire que aporta un vendedor libre. */
  topeDe(p: Puesto, porDefecto: number): number {
    return p.tope ?? porDefecto;
  }

  private llamadaPorCanal(canalId: string): Llamada | undefined {
    const id = this.porCanal.get(canalId);
    return id === undefined ? undefined : this.llamadas.get(id);
  }

  private usoDe(gatewayId: number) {
    let u = this.enUso.get(gatewayId);
    if (!u) this.enUso.set(gatewayId, (u = { total: 0, auto: 0, disparos: [] }));
    return u;
  }

  private estadisticaDe(campanaId: number): Estadistica {
    let e = this.estadisticas.get(campanaId);
    if (!e) this.estadisticas.set(campanaId, (e = { intentos: [], humanos: [], conectadas: [], abandonos: [] }));
    return e;
  }

  private programar(ll: Llamada, ms: number, fn: () => Promise<void>): void {
    this.limpiarTemporizador(ll);
    ll.temporizador = setTimeout(() => {
      ll.temporizador = undefined;
      fn().catch((err: unknown) => this.log.error({ err, llamada: ll.id }, 'Error en temporizador de llamada'));
    }, ms);
  }

  private limpiarTemporizador(ll: Llamada): void {
    if (ll.temporizador) clearTimeout(ll.temporizador);
    ll.temporizador = undefined;
  }
}

/** Las que lanza el discador solo: no pueden usar los canales reservados para manual. */
function esAutomatica(origen: Llamada['origen']): boolean {
  return origen === 'discador' || origen === 'ivr';
}

/** Causas de Asterisk que indican falla de red o número, no "no contesta". */
const CAUSAS_FALLA = new Set([1, 3, 21, 27, 28, 34, 38, 41, 42, 44, 58, 88]);

/** Error de negocio del puesto: la API lo responde como 400 con el mensaje. */
export class ErrorPuesto extends Error {
  readonly statusCode = 400;
}

export async function cargarParametrosCampana(db: pg.Pool, campanaId: number): Promise<ParametrosCampana | null> {
  const { rows } = await db.query<ParametrosCampana>(
    `SELECT ${COLUMNAS_PARAMETROS} FROM campanas c ${JOIN_AUDIOS_PARAMETROS} WHERE c.id = $1`,
    [campanaId],
  );
  return rows[0] ?? null;
}
