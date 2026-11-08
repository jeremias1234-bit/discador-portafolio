// Softphone WebRTC del puesto. El vendedor no atiende llamadas sueltas: abre una sola
// "línea" (llama al 9000) y queda en su bridge; el backend le conecta ahí cada cliente.
// Si la línea se corta sin que el vendedor la cierre, se vuelve a abrir sola.
import { UA, WebSocketInterface } from 'jssip';
import type { RTCSession } from 'jssip/lib/RTCSession';

export type EstadoRegistro = 'apagado' | 'conectando' | 'registrado' | 'sin_conexion' | 'rechazado';
export type EstadoLinea = 'cerrada' | 'abriendo' | 'abierta';

export interface EstadoSoftphone {
  registro: EstadoRegistro;
  linea: EstadoLinea;
  silenciado: boolean;
  volumen: number;
  error: string | null;
  /** El navegador no dejó reproducir el audio: hace falta un clic en "Activar audio". */
  audioBloqueado: boolean;
}

export interface DatosSoftphone {
  interno: string;
  clave: string;
  /** wss://servidor:8089/ws */
  urlWss: string;
}

const EXTENSION_LINEA = '9000';
const REINTENTO_LINEA_MS = 3000;

export function urlWssPorDefecto(): string {
  return import.meta.env.VITE_SIP_WSS ?? `wss://${location.hostname}:8089/ws`;
}

export class Softphone {
  private ua: UA | null = null;
  private sesion: RTCSession | null = null;
  private quiereLinea = false;
  private reintento: ReturnType<typeof setTimeout> | undefined;
  private oyentes = new Set<(e: EstadoSoftphone) => void>();
  // Reproductor del audio que llega (cliente, tono): dentro de la página, no suelto
  private audio = Object.assign(document.createElement('audio'), { autoplay: true, hidden: true });
  private remoto: MediaStream | null = null;
  private dominio = '';
  estado: EstadoSoftphone = { registro: 'apagado', linea: 'cerrada', silenciado: false, volumen: 1, error: null, audioBloqueado: false };

  constructor() {
    document.body.appendChild(this.audio);
  }

  /** Reproduce lo que tenga el reproductor; si el navegador lo bloquea, lo avisa en vez de quedar mudo. */
  private reproducir(): void {
    this.audio.volume = this.estado.volumen;
    this.audio.play().then(
      () => this.estado.audioBloqueado && this.cambiar({ audioBloqueado: false }),
      () => this.cambiar({ audioBloqueado: true }),
    );
  }

  private usarRemoto(stream: MediaStream): void {
    this.remoto = stream;
    this.audio.srcObject = stream;
    this.reproducir();
  }

  /** Clic del vendedor: con ese gesto el navegador deja reproducir. */
  activarAudio(): void {
    this.reproducir();
  }

  /** Tono de 1 s por el mismo reproductor (sin línea): prueba parlantes y permisos del navegador. */
  async probarAudioLocal(): Promise<boolean> {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const destino = ctx.createMediaStreamDestination();
    osc.frequency.value = 425;
    osc.connect(destino);
    osc.start();
    this.audio.srcObject = destino.stream;
    this.audio.volume = this.estado.volumen;
    const ok = await this.audio.play().then(() => true, () => false);
    this.cambiar({ audioBloqueado: !ok });
    await new Promise((r) => setTimeout(r, 1000));
    osc.stop();
    void ctx.close();
    this.audio.srcObject = this.remoto;
    if (this.remoto) this.reproducir();
    return ok;
  }

  suscribir(fn: (e: EstadoSoftphone) => void): () => void {
    this.oyentes.add(fn);
    fn(this.estado);
    return () => this.oyentes.delete(fn);
  }

  private cambiar(parcial: Partial<EstadoSoftphone>): void {
    this.estado = { ...this.estado, ...parcial };
    for (const fn of this.oyentes) fn(this.estado);
  }

  iniciar({ interno, clave, urlWss }: DatosSoftphone): void {
    this.detener();
    this.dominio = new URL(urlWss.replace(/^wss?:/, 'https:')).hostname;
    const ua = new UA({
      sockets: [new WebSocketInterface(urlWss)],
      uri: `sip:${interno}@${this.dominio}`,
      password: clave,
      register: true,
      session_timers: false,
      user_agent: 'Discador',
    });
    ua.on('connecting', () => this.cambiar({ registro: 'conectando' }));
    ua.on('disconnected', () =>
      this.cambiar({
        registro: 'sin_conexion',
        error: `No se pudo conectar con ${urlWss}. Si es la primera vez en esta PC, instalá la CA del discador: curl -fsSk https://${location.host}/api/instalar-ca.sh | sudo bash (y reiniciá el navegador).`,
      }),
    );
    ua.on('registered', () => {
      this.cambiar({ registro: 'registrado', error: null });
      if (this.quiereLinea && !this.sesion) this.llamarLinea();
    });
    ua.on('unregistered', () => this.cambiar({ registro: 'apagado' }));
    ua.on('registrationFailed', (e: { cause?: string }) =>
      this.cambiar({ registro: 'rechazado', error: `El servidor rechazó el interno ${interno} (${e.cause ?? 'sin motivo'})` }),
    );
    this.ua = ua;
    ua.start();
  }

  detener(): void {
    this.quiereLinea = false;
    clearTimeout(this.reintento);
    this.sesion?.terminate();
    this.sesion = null;
    this.ua?.stop();
    this.ua = null;
    this.cambiar({ registro: 'apagado', linea: 'cerrada' });
  }

  /** Al desmontar el teléfono: corta todo y saca el reproductor de la página. */
  destruir(): void {
    this.detener();
    this.audio.srcObject = null;
    this.audio.remove();
  }

  abrirLinea(): void {
    this.quiereLinea = true;
    if (!this.sesion && this.estado.registro === 'registrado') this.llamarLinea();
  }

  cerrarLinea(): void {
    this.quiereLinea = false;
    clearTimeout(this.reintento);
    this.sesion?.terminate();
    this.sesion = null;
    this.cambiar({ linea: 'cerrada' });
  }

  private llamarLinea(): void {
    if (!this.ua) return;
    this.cambiar({ linea: 'abriendo' });
    let sesion: RTCSession;
    try {
      sesion = this.ua.call(`sip:${EXTENSION_LINEA}@${this.dominio}`, {
        mediaConstraints: { audio: true, video: false },
        // Todo es red local: sin STUN, así no se espera a juntar candidatos externos
        pcConfig: { iceServers: [] },
        rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      });
    } catch (err) {
      this.cambiar({ linea: 'cerrada', error: `No se pudo abrir la línea: ${(err as Error).message}` });
      return;
    }
    this.sesion = sesion;
    // Un solo camino para el audio (ver filtrarCandidatos)
    sesion.on('sdp', (e) => {
      e.sdp = filtrarCandidatos(e.sdp, this.dominio);
    });
    sesion.on('peerconnection', ({ peerconnection }) => {
      peerconnection.addEventListener('track', (e) => this.usarRemoto(e.streams[0] ?? new MediaStream([e.track])));
    });
    sesion.on('confirmed', () => {
      // Por si el evento 'track' no llegó: el audio se toma de lo que recibe la conexión
      const pistas = sesion.connection?.getReceivers().map((r) => r.track).filter((t) => t?.kind === 'audio') ?? [];
      if (pistas.length && (!this.remoto || this.remoto.getAudioTracks().length === 0)) this.usarRemoto(new MediaStream(pistas));
      if (this.estado.silenciado) sesion.mute({ audio: true });
      this.cambiar({ linea: 'abierta', error: null });
    });
    const alTerminar = (motivo: string) => {
      if (this.sesion !== sesion) return;
      this.sesion = null;
      this.cambiar({ linea: 'cerrada' });
      if (this.quiereLinea) {
        this.cambiar({ error: `Se cortó la línea (${motivo}). Reconectando…` });
        this.reintento = setTimeout(() => {
          if (this.quiereLinea && !this.sesion && this.estado.registro === 'registrado') this.llamarLinea();
        }, REINTENTO_LINEA_MS);
      }
    };
    sesion.on('ended', (e) => alTerminar(e.cause));
    sesion.on('failed', (e) => {
      if (e.cause === 'User Denied Media Access') {
        this.quiereLinea = false;
        this.cambiar({ error: 'El navegador no dio permiso para usar el micrófono.' });
      }
      alTerminar(e.cause);
    });
  }

  silenciar(si: boolean): void {
    if (this.sesion?.isEstablished()) {
      if (si) this.sesion.mute({ audio: true });
      else this.sesion.unmute({ audio: true });
    }
    this.cambiar({ silenciado: si });
  }

  fijarVolumen(v: number): void {
    this.audio.volume = v;
    this.cambiar({ volumen: v });
  }
}

/**
 * Deja un solo camino posible para el audio. Si el servidor o el navegador tienen varias
 * interfaces (VPN, LAN, Docker), ICE puede terminar con cada lado mandando por un par de
 * direcciones distinto: el navegador descarta el audio que le llega por otro par y el vendedor
 * no escucha al cliente (el cliente a él sí). Por eso:
 *   - de Asterisk (remoto) solo se usa el candidato con la IP del servidor;
 *   - del navegador (local), si alguno de sus candidatos es esa misma IP (la PC del servidor),
 *     solo ese; si no, todos (una PC de la oficina tiene una sola IP).
 * Si el servidor se nombra por DNS no se filtra nada.
 */
function filtrarCandidatos(sdp: string, servidor: string): string {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(servidor)) return sdp;
  const lineas = sdp.split(/\r?\n/);
  const esCandidato = (l: string) => l.startsWith('a=candidate:');
  const ip = (l: string) => l.split(' ')[4];
  const delServidor = lineas.filter((l) => esCandidato(l) && ip(l) === servidor);
  if (delServidor.length === 0) return sdp; // remoto sin esa IP o PC de la oficina: no se toca
  return lineas.filter((l) => !esCandidato(l) || ip(l) === servidor).join('\r\n');
}

/** Pitido corto para avisar que entró un cliente. */
export function tonoDeEntrada(volumen: number): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 880;
    g.gain.value = 0.2 * volumen;
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => void ctx.close();
  } catch {
    // sin audio disponible: no es crítico
  }
}
