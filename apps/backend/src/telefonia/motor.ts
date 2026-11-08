// Motor de marcación (§4): cada `ritmo.recuento_campanas_seg` segundos decide cuántas llamadas
// lanzar por campaña activa y deja la explicación de cada decisión para el monitor.
//
//   progresivo         objetivo = Σ tope de cada vendedor libre (tope propio o llamadas por vendedor)
//   predictivo(+audio) objetivo = libres / tasa de contacto reciente, con factor que baja si el
//                      abandono supera el objetivo y sube despacio si sobra margen; nunca más que el progresivo
//   ivr                llena sus canales (ivr_canales o tope_canales) sin depender de vendedores
//                      (también el IVR con aviso: los vendedores reciben el número, no la llamada)
//
// Siempre limitado por: ráfaga por ciclo, límite por minuto, tope de canales de la campaña,
// canales libres de sus gateways (respetando la reserva para manual) y llamadas por segundo
// (del gateway y de la campaña).
//
// El límite por minuto es uno solo para todo el discador. Entre campañas de la misma prioridad se
// reparte según sus canales: en cada ciclo va primero la que menos marcó en el último minuto en
// proporción a sus canales (dos campañas de 15 canales = mitad y mitad). Si una no tiene a quién
// llamar, la otra usa el resto.
import type pg from 'pg';
import type { CacheConfiguracion, Config } from '../configuracion.js';
import { sqlBloqueado } from '../noLlame.js';
import { COLUMNAS_PARAMETROS, JOIN_AUDIOS_PARAMETROS, type Conmutador, type GatewayVivo, type ParametrosCampana, type TipoCampana } from './conmutador.js';
import { cargarReglas, momentoEn, motivoFueraDeHorario } from './horario.js';

interface CampanaMotor extends ParametrosCampana {
  hora_inicio: string;
  hora_fin: string;
  dias_semana: number[];
  todos_los_gateways: boolean;
  gateways: number[] | null;
  tope_canales: number | null;
  ivr_canales: number | null;
  llamadas_por_vendedor: number | null;
  puertos_por_vendedor_auto: boolean;
  abandono_objetivo_pct: number | null;
  llamadas_por_segundo: number | null;
}

export interface Decision {
  campana_id: number;
  campana: string;
  tipo: TipoCampana;
  ts: number;
  marcando: boolean;
  motivo: string;
  vendedores_libres: number;
  en_vuelo: number;
  activas: number;
  objetivo: number;
  lanzadas: number;
  tasa_contacto: number | null;
  abandono_pct: number | null;
  puertos_por_vendedor?: number;
  abandono_objetivo_pct: number;
  factor: number;
}

const TASA_CONTACTO_INICIAL = 0.3;
const FACTOR_MIN = 0.3;

/** Llegadas (al vendedor + abandonos) mínimas para que el % de abandono frene el ritmo. */
const MIN_LLEGADAS_ABANDONO = 20;

export class Motor {
  private temporizador?: NodeJS.Timeout;
  private corriendo = false;
  private readonly factores = new Map<number, number>();
  readonly decisiones = new Map<number, Decision>();

  constructor(
    private readonly db: pg.Pool,
    private readonly configuracion: CacheConfiguracion,
    private readonly conmutador: Conmutador,
    private readonly log: { error: (o: object, m?: string) => void },
  ) {}

  async iniciar(): Promise<void> {
    await this.ciclo();
  }

  detener(): void {
    if (this.temporizador) clearTimeout(this.temporizador);
  }

  private async ciclo(): Promise<void> {
    let espera = 2000;
    if (!this.corriendo) {
      this.corriendo = true;
      try {
        const config = await this.configuracion.obtener();
        espera = config['ritmo.recuento_campanas_seg'] * 1000;
        await this.actualizarConmutador(config);
        await this.marcar(config);
      } catch (err) {
        this.log.error({ err }, 'Error en el ciclo del motor');
      } finally {
        this.corriendo = false;
      }
    }
    this.temporizador = setTimeout(() => void this.ciclo(), espera);
  }

  /** Datos que el conmutador consulta en caliente: config, horario, gateways y asignaciones. */
  private async actualizarConmutador(config: Config): Promise<void> {
    const [reglas, gateways, asignaciones] = await Promise.all([
      cargarReglas(this.db),
      this.db.query<GatewayVivo>(
        `SELECT id, nombre, endpoint_pjsip AS endpoint, canales, canales_reservados_manual AS reservados,
                llamadas_por_segundo::float8 AS "llamadasPorSegundo", orden
           FROM gateways WHERE activo AND ip IS NOT NULL ORDER BY orden, id`,
      ),
      this.db.query<{ campana_id: number; usuario_id: number }>('SELECT campana_id, usuario_id FROM campana_vendedores'),
    ]);
    const mapa = new Map<number, Set<number>>();
    for (const a of asignaciones.rows) {
      if (!mapa.has(a.campana_id)) mapa.set(a.campana_id, new Set());
      mapa.get(a.campana_id)!.add(a.usuario_id);
    }
    Object.assign(this.conmutador, { config, reglas, gateways: gateways.rows, asignaciones: mapa });
  }

  private async marcar(config: Config): Promise<void> {
    const { rows: campanas } = await this.db.query<CampanaMotor>(
      `SELECT ${COLUMNAS_PARAMETROS},
              to_char(c.hora_inicio, 'HH24:MI') AS hora_inicio, to_char(c.hora_fin, 'HH24:MI') AS hora_fin,
              c.dias_semana, c.todos_los_gateways, c.tope_canales, c.ivr_canales,
              c.llamadas_por_vendedor::float8 AS llamadas_por_vendedor, c.puertos_por_vendedor_auto,
              c.abandono_objetivo_pct::float8 AS abandono_objetivo_pct, c.llamadas_por_segundo::float8 AS llamadas_por_segundo,
              (SELECT array_agg(cg.gateway_id) FROM campana_gateways cg WHERE cg.campana_id = c.id) AS gateways
         FROM campanas c ${JOIN_AUDIOS_PARAMETROS}
        WHERE c.estado = 'activa' AND c.tipo <> 'manual'
        ORDER BY c.prioridad DESC, c.id`,
    );
    const activas = new Set(campanas.map((c) => c.id));
    for (const id of this.decisiones.keys()) if (!activas.has(id)) this.decisiones.delete(id);

    const momento = momentoEn(config['general.zona_horaria']);
    let restanteMinuto = config['ritmo.limite_por_minuto'] - this.conmutador.disparosUltimoMinuto();

    // Mayor prioridad primero; a igual prioridad, la que menos marcó en el último minuto por canal
    const orden = campanas
      .map((c) => ({ c, uso: this.conmutador.disparosDe(c.id, 60_000) / this.canalesDe(c) }))
      .sort((a, b) => b.c.prioridad - a.c.prioridad || a.uso - b.uso || a.c.id - b.c.id);
    for (const { c } of orden) {
      const d = this.decidir(c, config, momento, restanteMinuto);
      if (d.lanzadas > 0) {
        d.lanzadas = await this.lanzar(c, d.lanzadas);
        restanteMinuto -= d.lanzadas;
      }
      this.decisiones.set(c.id, d);
    }
  }

  private decidir(c: CampanaMotor, config: Config, momento: ReturnType<typeof momentoEn>, restanteMinuto: number): Decision {
    const libres = c.tipo === 'ivr' ? [] : this.conmutador.libresPara(c);
    const { enVuelo, activas } = this.conmutador.llamadasDe(c.id);
    const est = this.conmutador.estadistica(c.id);
    const objetivoAbandono = c.abandono_objetivo_pct ?? config['ritmo.abandono_objetivo_pct'];
    const llegadas = est.conectadas + est.abandonos;
    const abandono = llegadas > 0 ? (est.abandonos / llegadas) * 100 : null;
    const tasa = est.intentos >= config['ritmo.muestras_minimas'] ? est.humanos / est.intentos : null;
    // Con pocas llamadas el % de abandono no dice nada (1 de 9 = 11 %): no se frena hasta tener muestra
    const factor = this.ajustarFactor(c.id, llegadas >= MIN_LLEGADAS_ABANDONO ? abandono : null, objetivoAbandono, config);

    const d: Decision = {
      campana_id: c.id, campana: c.nombre, tipo: c.tipo, ts: Date.now(), marcando: false, motivo: '',
      vendedores_libres: libres.length, en_vuelo: enVuelo, activas, objetivo: 0, lanzadas: 0,
      tasa_contacto: tasa === null ? null : Math.round(tasa * 1000) / 1000,
      abandono_pct: abandono === null ? null : Math.round(abandono * 10) / 10,
      abandono_objetivo_pct: objetivoAbandono, factor: Math.round(factor * 100) / 100,
    };

    const fuera = motivoFueraDeHorario(this.conmutador.reglas, momento, c);
    if (fuera) return { ...d, motivo: fuera };
    if ((c.tipo === 'predictivo_audio' || c.tipo === 'ivr') && !c.audio_archivo) return { ...d, motivo: 'la campaña no tiene audio' };

    const ratio = c.puertos_por_vendedor_auto ? this.puertosPorVendedor(c) : (c.llamadas_por_vendedor ?? config['ritmo.llamadas_por_vendedor']);
    d.puertos_por_vendedor = Math.round(ratio * 10) / 10;
    const maximo = libres.reduce((s, p) => s + this.conmutador.topeDe(p, ratio), 0);
    let objetivo: number;
    if (c.tipo === 'ivr') {
      objetivo = c.ivr_canales ?? c.tope_canales ?? Infinity;
    } else if (libres.length === 0) {
      return { ...d, motivo: 'sin vendedores libres' };
    } else if (c.tipo === 'progresivo') {
      // Progresivo: una llamada por vendedor libre, sin ritmo ni tope por vendedor (cero abandono)
      objetivo = libres.length;
    } else if (!config['ritmo.adaptativo'] || tasa === null) {
      // Sin contactabilidad medida todavía: ritmo inicial global, con los puertos por vendedor como tope
      const inicial = c.puertos_por_vendedor_auto ? Math.min(maximo, libres.length * config['ritmo.llamadas_por_vendedor']) : maximo;
      objetivo = inicial * factor;
      if (tasa === null) d.motivo = `juntando muestras (${est.intentos}/${config['ritmo.muestras_minimas']})`;
    } else {
      objetivo = Math.min(maximo, (libres.length / Math.max(tasa, 0.02)) * factor);
    }
    // El predictivo nunca marca menos que el progresivo: al menos una llamada por vendedor libre
    if (c.tipo === 'predictivo' || c.tipo === 'predictivo_audio') objetivo = Math.max(objetivo, libres.length);
    objetivo = Math.max(c.tipo === 'ivr' ? 0 : 1, Math.round(objetivo === Infinity ? 1e6 : objetivo));
    d.objetivo = objetivo === 1e6 ? -1 : objetivo; // -1 = "todos los canales libres"

    let lanzar = objetivo - enVuelo;
    lanzar = Math.min(lanzar, config['ritmo.rafaga_por_ciclo'], restanteMinuto);
    if (c.tope_canales) lanzar = Math.min(lanzar, c.tope_canales - activas);
    let porSegundo = false;
    if (c.llamadas_por_segundo && lanzar > 0) {
      // Ventana de al menos 1 s: 0,5 por segundo = 1 cada 2 s
      const ventanaMs = Math.max(1000, 1000 / c.llamadas_por_segundo);
      const maximo = Math.max(1, Math.round((c.llamadas_por_segundo * ventanaMs) / 1000));
      const disponibles = maximo - this.conmutador.disparosDe(c.id, ventanaMs);
      porSegundo = disponibles < lanzar;
      lanzar = Math.min(lanzar, disponibles);
    }
    if (lanzar <= 0) {
      const freno = restanteMinuto <= 0 ? 'límite por minuto alcanzado' : porSegundo ? 'llamadas por segundo de la campaña' : 'objetivo cubierto';
      return { ...d, marcando: true, motivo: d.motivo || freno };
    }
    return { ...d, marcando: true, lanzadas: lanzar, motivo: d.motivo || 'marcando' };
  }

  /**
   * Puertos por vendedor en modo automático: los puertos de la campaña (sin los reservados para
   * manual) repartidos entre sus vendedores con la línea conectada. 25 puertos y 5 vendedores = 5.
   */
  private puertosPorVendedor(c: CampanaMotor): number {
    const conectados = [...(this.conmutador.asignaciones.get(c.id) ?? [])].filter((u) => this.conmutador.puesto(u)).length;
    return Math.max(1, Math.floor(this.puertosDe(c) / Math.max(1, conectados)));
  }

  /** Puertos de los gateways de la campaña, sin los reservados para manual. */
  private puertosDe(c: CampanaMotor): number {
    const permitidos = c.todos_los_gateways ? null : (c.gateways ?? []);
    return this.conmutador.gateways
      .filter((g) => !permitidos || permitidos.includes(g.id))
      .reduce((t, g) => t + Math.max(0, g.canales - g.reservados), 0);
  }

  /** Canales con los que cuenta la campaña: su tope (en el IVR, sus canales) o los puertos de sus gateways. */
  private canalesDe(c: CampanaMotor): number {
    return Math.max(1, (c.tipo === 'ivr' ? c.ivr_canales : null) ?? c.tope_canales ?? this.puertosDe(c));
  }

  /** Control de abandono: baja rápido si se pasa del objetivo, sube despacio si hay margen. */
  private ajustarFactor(campanaId: number, abandono: number | null, objetivo: number, config: Config): number {
    let f = this.factores.get(campanaId) ?? 1;
    if (config['ritmo.adaptativo'] && abandono !== null) {
      if (abandono > objetivo) f = Math.max(FACTOR_MIN, f * 0.85);
      else if (abandono < objetivo * 0.7) f = Math.min(1, f * 1.05);
    }
    this.factores.set(campanaId, f);
    return f;
  }

  /** Toma leads de la cola y origina; devuelve cuántas se lanzaron de verdad. */
  private async lanzar(c: CampanaMotor, cantidad: number): Promise<number> {
    const permitidos = c.todos_los_gateways ? null : (c.gateways ?? []);
    if (!this.conmutador.elegirGateway(permitidos, false)) return 0;

    const { rows: leads } = await this.db.query<{ id: number; telefono: string; lista_id: number; bloqueado: boolean }>(
      `WITH elegidos AS (
         SELECT l.id FROM leads l JOIN listas li ON li.id = l.lista_id AND li.activa
          WHERE l.campana_id = $1 AND l.estado IN ('pendiente', 'reintentar') AND l.proximo_intento <= now()
          ORDER BY l.prioridad DESC, l.proximo_intento
          LIMIT $2 FOR UPDATE OF l SKIP LOCKED)
       UPDATE leads SET estado = 'en_curso' FROM elegidos WHERE leads.id = elegidos.id
       RETURNING leads.id, leads.telefono, leads.lista_id, ${sqlBloqueado('leads.telefono')} AS bloqueado`,
      [c.id, cantidad],
    );

    let lanzadas = 0;
    for (const lead of leads) {
      // Consulta No Llame antes de cada marcación (§8), además del cruce al cargar
      if (lead.bloqueado) {
        await this.db.query("UPDATE leads SET estado = 'no_llamar' WHERE id = $1", [lead.id]);
        continue;
      }
      const gateway = this.conmutador.telefonoEnCurso(lead.telefono) ? null : this.conmutador.elegirGateway(permitidos, false);
      if (!gateway) {
        await this.db.query("UPDATE leads SET estado = 'reintentar' WHERE id = $1", [lead.id]);
        continue;
      }
      await this.conmutador.originarAutomatica(c, lead, gateway);
      lanzadas++;
    }
    return lanzadas;
  }
}
