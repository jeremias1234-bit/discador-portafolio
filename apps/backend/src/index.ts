import { Redis } from 'ioredis';
import pg from 'pg';
import { crearServidor } from './api/servidor.js';
import { AriCliente } from './ari/cliente.js';
import { Avisos } from './avisos.js';
import { Sesiones } from './auth/sesiones.js';
import { config } from './config.js';
import { CacheConfiguracion } from './configuracion.js';
import { CANAL_EVENTOS, type Evento } from './eventos.js';
import { sincronizarPjsip } from './telefonia/asterisk.js';
import { Conmutador } from './telefonia/conmutador.js';
import { Motor } from './telefonia/motor.js';

const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
const redis = new Redis(config.REDIS_URL);
const suscriptor = redis.duplicate(); // una conexión en modo suscripción no puede hacer otras consultas
const ari = new AriCliente({
  url: config.ARI_URL,
  usuario: config.ARI_USUARIO,
  password: config.ARI_PASSWORD,
  app: config.ARI_APP,
});

// El logger es el de Fastify, que existe recién después de crear el servidor
let app: Awaited<ReturnType<typeof crearServidor>> | undefined;
const log = {
  info: (o: object, m?: string) => app?.log.info(o, m),
  warn: (o: object, m?: string) => app?.log.warn(o, m),
  error: (o: object, m?: string) => app?.log.error(o, m),
};

const sesiones = new Sesiones(redis, Math.round(config.SESION_HORAS * 3600));
const configuracion = new CacheConfiguracion(db, suscriptor);
const conmutador = new Conmutador(db, ari, log);
const motor = new Motor(db, configuracion, conmutador, log);
const avisos = new Avisos(db, log);
conmutador.on('aviso_ivr', (d) => void avisos.crear(d).catch(() => {}));

app = await crearServidor({ db, redis, ari, sesiones, configuracion, conmutador, motor, avisos });

async function sincronizarAsterisk(): Promise<void> {
  try {
    if (await sincronizarPjsip(db, ari, config.ARCHIVO_PJSIP)) log.info({}, 'PJSIP regenerado y recargado');
  } catch (err) {
    log.error({ err }, 'No se pudo regenerar la configuración de PJSIP');
  }
}

let primeraConexion = true;
ari.on('conectado', () => {
  log.info({}, 'ARI conectado');
  void sincronizarAsterisk();
  if (primeraConexion) {
    primeraConexion = false;
    void conmutador.limpiarHuerfanos().catch((err: unknown) => log.error({ err }, 'No se pudieron limpiar canales huérfanos'));
  }
});
ari.on('desconectado', () => log.warn({}, 'ARI desconectado, reintentando...'));
ari.on('error', (err: Error) => log.error({ err }, 'Error en ARI'));

// Cambios hechos desde el panel que afectan a Asterisk
await suscriptor.subscribe(CANAL_EVENTOS);
suscriptor.on('message', (canal: string, mensaje: string) => {
  if (canal !== CANAL_EVENTOS) return;
  const evento = JSON.parse(mensaje) as Evento;
  if (evento.tipo === 'usuarios.actualizados' || evento.tipo === 'gateways.actualizados') void sincronizarAsterisk();
  if (evento.tipo === 'usuarios.actualizados') {
    void conmutador.refrescarPuestos().catch((err: unknown) => log.error({ err }, 'No se pudieron refrescar los puestos'));
  }
});

await conmutador.recuperar();
ari.conectar();

// Vigilante de canales: reconcilia el conmutador con los canales reales de Asterisk
const INTERVALO_VIGILANTE_MS = 15_000;
const vigilante = setInterval(() => {
  if (!ari.conectado) return;
  void conmutador.vigilar().catch((err: unknown) => log.error({ err }, 'Error en el vigilante de canales'));
}, INTERVALO_VIGILANTE_MS);
await motor.iniciar();
await app.listen({ host: '0.0.0.0', port: config.PUERTO_API });

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(senal, async () => {
    log.info({}, `Recibido ${senal}, cerrando...`);
    motor.detener();
    clearInterval(vigilante);
    ari.cerrar();
    await app?.close();
    await db.end();
    redis.disconnect();
    suscriptor.disconnect();
    process.exit(0);
  });
}
