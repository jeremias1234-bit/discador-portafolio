import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { AriCliente } from '../ari/cliente.js';
import type { Avisos } from '../avisos.js';
import type { Sesiones } from '../auth/sesiones.js';
import type { CacheConfiguracion } from '../configuracion.js';
import type { Conmutador } from '../telefonia/conmutador.js';
import type { Motor } from '../telefonia/motor.js';
import { config } from '../config.js';
import { rutasAdministracion } from './administracion.js';
import { rutasAmd } from './amd.js';
import { rutasAudios } from './audios.js';
import { rutasAvisos } from './avisos.js';
import { instalarAutenticacion } from './autenticacion.js';
import { rutasCampanas } from './campanas.js';
import { codigoPg, mensajeRestriccion } from './errores.js';
import { rutasGrabaciones } from './grabaciones.js';
import { rutasLeads } from './leads.js';
import { rutasListas } from './listas.js';
import { rutasNoLlame } from './noLlame.js';
import { rutasPuesto } from './puesto.js';
import { rutasReportes } from './reportes.js';
import { rutasTiempoReal } from './tiempoReal.js';
import { rutasUsuarios } from './usuarios.js';

export interface Dependencias {
  db: pg.Pool;
  redis: Redis;
  ari: AriCliente;
  sesiones: Sesiones;
  configuracion: CacheConfiguracion;
  conmutador: Conmutador;
  motor: Motor;
  avisos: Avisos;
}

export async function crearServidor(deps: Dependencias) {
  const { db, redis, ari } = deps;
  const app = Fastify({ logger: true });

  // Errores de la base que llegan sin traducir: respuestas claras en lugar de un 500
  app.setErrorHandler((err, _req, reply) => {
    const codigo = codigoPg(err);
    const restriccion = (err as { constraint?: string }).constraint;
    if (codigo === '23505') return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: `Ya existe un registro igual (${restriccion})` });
    if (codigo === '23503') return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: `Referencia inválida o registro en uso (${restriccion})` });
    if (codigo === '23514' || codigo === '22P02' || codigo === '22007') {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: mensajeRestriccion(restriccion) ?? `Valor inválido (${restriccion ?? (err as Error).message})` });
    }
    return reply.send(err);
  });

  // Un POST de acción (colgar, salir...) puede venir con cabecera JSON y sin cuerpo: se toma como {}
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, cuerpo: string, listo) => {
    if (cuerpo.trim() === '') return listo(null, {});
    try {
      listo(null, JSON.parse(cuerpo));
    } catch {
      listo(Object.assign(new Error('JSON inválido'), { statusCode: 400 }), undefined);
    }
  });

  // Se espera el plugin para que las cookies estén parseadas antes del hook de sesión
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
  await app.register(websocket);
  instalarAutenticacion(app, deps);
  rutasUsuarios(app, deps);
  rutasCampanas(app, deps);
  rutasListas(app, deps);
  rutasNoLlame(app, deps);
  rutasAdministracion(app, deps);
  rutasAudios(app, deps);
  rutasPuesto(app, deps);
  rutasTiempoReal(app, deps);
  rutasGrabaciones(app, deps);
  rutasReportes(app, deps);
  rutasAmd(app, deps);
  rutasAvisos(app, deps);
  rutasLeads(app, deps);

  // CA interna para las PCs de la oficina (sin sesión: hace falta antes de poder entrar)
  app.get('/api/ca.crt', async (_req, reply) => {
    const pem = await readFile(config.ARCHIVO_CA, 'utf8').catch(() => null);
    if (!pem) return reply.code(404).send({ message: 'Todavía no se creó la CA (scripts/tls/crear-certificados.sh)' });
    return reply.type('application/x-x509-ca-cert').header('Content-Disposition', 'attachment; filename="discador-ca.crt"').send(pem);
  });
  app.get('/api/instalar-ca.sh', async (_req, reply) => {
    const [pem, script] = await Promise.all([
      readFile(config.ARCHIVO_CA, 'utf8').catch(() => null),
      readFile(join(import.meta.dirname, '../../../../scripts/tls/instalar-ca-en-pc.sh'), 'utf8'),
    ]);
    if (!pem) return reply.code(404).send({ message: 'Todavía no se creó la CA (scripts/tls/crear-certificados.sh)' });
    return reply.type('text/x-shellscript; charset=utf-8').send(script.replace('__CA_PEM__', pem.trim()));
  });

  // Estado de cada dependencia: útil para monitoreo y para diagnosticar la instalación
  app.get('/api/salud', async (_req, reply) => {
    const [postgres, redisOk] = await Promise.all([
      db.query('SELECT 1').then(() => true, () => false),
      redis.ping().then(() => true, () => false),
    ]);
    const estado = { postgres, redis: redisOk, asterisk: ari.conectado };
    const todoOk = Object.values(estado).every(Boolean);
    return reply.code(todoOk ? 200 : 503).send(estado);
  });

  return app;
}
