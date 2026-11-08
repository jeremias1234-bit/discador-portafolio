// Cliente ARI propio: REST para dar órdenes y WebSocket para recibir eventos.
// Se evita depender de librerías de terceros poco mantenidas.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface AriConfig {
  url: string;
  usuario: string;
  password: string;
  app: string;
}

/** Evento crudo de ARI. `type` es el nombre (StasisStart, ChannelStateChange, ...). */
export interface AriEvento {
  type: string;
  application: string;
  timestamp: string;
  [campo: string]: unknown;
}

export interface AriCanal {
  id: string;
  name: string;
  state: string;
  caller: { name: string; number: string };
  connected: { name: string; number: string };
  dialplan: { context: string; exten: string; priority: number };
}

export interface AriBridge {
  id: string;
  bridge_type: string;
  channels: string[];
}

type Metodo = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Parametros = Record<string, string | number | boolean | undefined>;

const ESPERA_MAXIMA_RECONEXION_MS = 30_000;

export class AriCliente extends EventEmitter {
  private ws?: WebSocket;
  private cerrado = false;
  private reintentos = 0;
  private readonly auth: string;

  constructor(private readonly cfg: AriConfig) {
    super();
    this.auth = 'Basic ' + Buffer.from(`${cfg.usuario}:${cfg.password}`).toString('base64');
  }

  get conectado(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  conectar(): void {
    this.cerrado = false;
    const url = new URL('/ari/events', this.cfg.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('app', this.cfg.app);

    const ws = new WebSocket(url, { headers: { Authorization: this.auth } });
    this.ws = ws;

    ws.on('open', () => {
      this.reintentos = 0;
      this.emit('conectado');
    });
    ws.on('message', (datos) => {
      let evento: AriEvento;
      try {
        evento = JSON.parse(datos.toString()) as AriEvento;
      } catch {
        return;
      }
      this.emit('evento', evento);
      this.emit(evento.type, evento);
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', () => {
      this.emit('desconectado');
      if (!this.cerrado) this.programarReconexion();
    });
  }

  cerrar(): void {
    this.cerrado = true;
    this.ws?.close();
  }

  private programarReconexion(): void {
    const espera = Math.min(ESPERA_MAXIMA_RECONEXION_MS, 1000 * 2 ** this.reintentos);
    this.reintentos++;
    setTimeout(() => {
      if (!this.cerrado) this.conectar();
    }, espera);
  }

  async solicitud<T>(metodo: Metodo, ruta: string, params?: Parametros, cuerpo?: unknown): Promise<T> {
    const url = new URL(`/ari${ruta}`, this.cfg.url);
    for (const [clave, valor] of Object.entries(params ?? {})) {
      if (valor !== undefined) url.searchParams.set(clave, String(valor));
    }

    const res = await fetch(url, {
      method: metodo,
      headers: {
        Authorization: this.auth,
        ...(cuerpo !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });

    if (!res.ok) {
      throw new Error(`ARI ${metodo} ${ruta} -> ${res.status} ${await res.text()}`);
    }
    const texto = await res.text();
    return (texto ? JSON.parse(texto) : undefined) as T;
  }

  // --- Operaciones que usan el motor y el gestor de agentes ---

  /**
   * Crea el canal sin marcar todavía: entra a Stasis enseguida, se puede meter en un bridge y
   * recién después se marca (marcar). Así el audio de la red mientras suena (183 con audio:
   * timbre real, mensajes de la operadora) le llega a quien está en el bridge.
   */
  crearCanal(opciones: { endpoint: string; canalId: string; appArgs?: string }): Promise<AriCanal> {
    return this.solicitud<AriCanal>('POST', '/channels/create', {
      endpoint: opciones.endpoint,
      channelId: opciones.canalId,
      app: this.cfg.app,
      appArgs: opciones.appArgs,
    });
  }

  /** Marca un canal creado con crearCanal. */
  marcar(canalId: string, timeoutSeg: number): Promise<void> {
    return this.solicitud('POST', `/channels/${encodeURIComponent(canalId)}/dial`, { timeout: timeoutSeg });
  }

  /** Origina una llamada. Ej. endpoint: 'PJSIP/1155551234@dinstar_10'. */
  originar(opciones: {
    endpoint: string;
    canalId?: string; // id propio del canal: se conoce antes de que llegue cualquier evento
    callerId?: string;
    timeoutSeg?: number;
    appArgs?: string;
    variables?: Record<string, string>;
  }): Promise<AriCanal> {
    return this.solicitud<AriCanal>(
      'POST',
      '/channels',
      {
        endpoint: opciones.endpoint,
        channelId: opciones.canalId,
        app: this.cfg.app,
        appArgs: opciones.appArgs,
        callerId: opciones.callerId,
        timeout: opciones.timeoutSeg,
      },
      opciones.variables ? { variables: opciones.variables } : undefined,
    );
  }

  colgar(canalId: string, motivo?: 'normal' | 'busy' | 'congestion' | 'no_answer'): Promise<void> {
    return this.solicitud('DELETE', `/channels/${encodeURIComponent(canalId)}`, { reason: motivo });
  }

  atender(canalId: string): Promise<void> {
    return this.solicitud('POST', `/channels/${encodeURIComponent(canalId)}/answer`);
  }

  definirVariable(canalId: string, variable: string, valor: string): Promise<void> {
    return this.solicitud('POST', `/channels/${encodeURIComponent(canalId)}/variable`, { variable, value: valor });
  }

  /** Reproduce un audio (ej. 'sound:campanas/a123_bienvenida'). */
  reproducir(canalId: string, media: string, playbackId: string): Promise<void> {
    return this.solicitud('POST', `/channels/${encodeURIComponent(canalId)}/play/${encodeURIComponent(playbackId)}`, {
      media,
    });
  }

  /** Reproduce en un bridge (lo escuchan todos los que están adentro). */
  reproducirEnBridge(bridgeId: string, media: string, playbackId: string): Promise<void> {
    return this.solicitud('POST', `/bridges/${encodeURIComponent(bridgeId)}/play/${encodeURIComponent(playbackId)}`, {
      media,
    });
  }

  detenerReproduccion(playbackId: string): Promise<void> {
    return this.solicitud('DELETE', `/playbacks/${encodeURIComponent(playbackId)}`);
  }

  musicaEnEspera(canalId: string, activar: boolean): Promise<void> {
    return this.solicitud(activar ? 'POST' : 'DELETE', `/channels/${encodeURIComponent(canalId)}/moh`);
  }

  /** Canal espía sobre `canalId`. spy: qué escucha; whisper: hacia dónde habla. */
  espiar(canalId: string, spy: 'none' | 'in' | 'out' | 'both', whisper: 'none' | 'in' | 'out' | 'both', appArgs: string): Promise<AriCanal> {
    return this.solicitud<AriCanal>('POST', `/channels/${encodeURIComponent(canalId)}/snoop`, {
      app: this.cfg.app,
      spy,
      whisper,
      appArgs,
    });
  }

  quitarDeBridge(bridgeId: string, canalId: string): Promise<void> {
    return this.solicitud('POST', `/bridges/${encodeURIComponent(bridgeId)}/removeChannel`, { channel: canalId });
  }

  borrarBridge(bridgeId: string): Promise<void> {
    return this.solicitud('DELETE', `/bridges/${encodeURIComponent(bridgeId)}`);
  }

  /** Graba todo lo que pasa en el bridge en /var/spool/asterisk/recording/<nombre>.wav */
  grabarBridge(bridgeId: string, nombre: string): Promise<void> {
    return this.solicitud('POST', `/bridges/${encodeURIComponent(bridgeId)}/record`, {
      name: nombre,
      format: 'wav',
      ifExists: 'overwrite',
    });
  }

  detenerGrabacion(nombre: string): Promise<void> {
    return this.solicitud('POST', `/recordings/live/${encodeURIComponent(nombre)}/stop`);
  }

  borrarGrabacion(nombre: string): Promise<void> {
    return this.solicitud('DELETE', `/recordings/stored/${encodeURIComponent(nombre)}`);
  }

  /** Descarga cruda de una grabación guardada (la sirve Asterisk). */
  async descargarGrabacion(nombre: string): Promise<Response> {
    const url = new URL(`/ari/recordings/stored/${encodeURIComponent(nombre)}/file`, this.cfg.url);
    return fetch(url, { headers: { Authorization: this.auth } });
  }

  estadoEndpoint(tecnologia: string, recurso: string): Promise<{ state: string; channel_ids: string[] }> {
    return this.solicitud('GET', `/endpoints/${tecnologia}/${encodeURIComponent(recurso)}`);
  }

  /** Suscribe la app a los eventos de un canal aunque salga de Stasis (ej. mientras corre AMD). */
  suscribir(origenEventos: string): Promise<void> {
    return this.solicitud('POST', `/applications/${encodeURIComponent(this.cfg.app)}/subscription`, {
      eventSource: origenEventos,
    });
  }

  /** Recarga un módulo de Asterisk (ej. 'res_pjsip.so' tras regenerar la configuración). */
  recargarModulo(modulo: string): Promise<void> {
    return this.solicitud('PUT', `/asterisk/modules/${encodeURIComponent(modulo)}`);
  }

  /** Saca el canal de Stasis y lo manda al dialplan (ej. contexto 'amd'). */
  continuarEnDialplan(canalId: string, contexto: string, extension = 's', prioridad = 1): Promise<void> {
    return this.solicitud('POST', `/channels/${encodeURIComponent(canalId)}/continue`, {
      context: contexto,
      extension,
      priority: prioridad,
    });
  }

  crearBridge(tipo = 'mixing'): Promise<AriBridge> {
    return this.solicitud<AriBridge>('POST', '/bridges', { type: tipo });
  }

  agregarABridge(bridgeId: string, canalId: string): Promise<void> {
    return this.solicitud('POST', `/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
      channel: canalId,
    });
  }
}
