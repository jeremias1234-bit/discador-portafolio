// Login, sesión y control de permisos del panel.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashearClave, simularVerificacion, verificarClave } from '../auth/contrasenas.js';
import { permisosEfectivos } from '../auth/permisos.js';
import { registrarEnBitacora } from '../bitacora.js';
import { config } from '../config.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

export type Rol = 'vendedor' | 'supervisor' | 'admin';

export interface UsuarioSesion {
  id: number;
  nombre: string;
  usuario: string;
  rol: Rol;
  sedeId: number | null;
  permisos: Set<string>;
}

declare module 'fastify' {
  interface FastifyRequest {
    usuario: UsuarioSesion | null;
    tokenSesion: string | null;
  }
  interface FastifyInstance {
    /** Usuario de un token de sesión (para el WebSocket de la extensión, que no puede mandar cabeceras). */
    usuarioDeToken: (token: string) => Promise<UsuarioSesion | null>;
  }
}

const COOKIE = 'sesion';
const MAX_FALLOS_LOGIN = 10;
const VENTANA_FALLOS_SEG = 15 * 60;

export const esquemaClave = z.string().min(8, 'mínimo 8 caracteres').max(200);

// --- Guardas para las rutas ---

export async function requiereSesion(req: FastifyRequest): Promise<void> {
  if (!req.usuario) throw errorHttp(401, 'Sesión requerida');
}

/** Alcanza con tener uno de los permisos indicados. */
export function requierePermiso(...codigos: string[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.usuario) throw errorHttp(401, 'Sesión requerida');
    if (!codigos.some((c) => req.usuario!.permisos.has(c))) {
      throw errorHttp(403, 'No tenés permiso para esta acción');
    }
  };
}

/** Usuario de la sesión; usar solo en rutas protegidas por una guarda. */
export function usuarioDe(req: FastifyRequest): UsuarioSesion {
  if (!req.usuario) throw errorHttp(401, 'Sesión requerida');
  return req.usuario;
}

// --- Instalación en el servidor raíz (sin encapsular: el hook aplica a todas las rutas) ---

export function instalarAutenticacion(app: FastifyInstance, { db, redis, sesiones }: Dependencias): void {
  const duracionSeg = Math.round(config.SESION_HORAS * 3600);
  const opcionesCookie = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.COOKIE_SEGURA,
    path: '/',
    maxAge: duracionSeg,
  };

  app.decorateRequest('usuario', null);
  app.decorateRequest('tokenSesion', null);

  // Carga el usuario de la sesión (si hay) con sus permisos efectivos. El panel manda la cookie;
  // la extensión de Chrome, el mismo token en la cabecera Authorization.
  app.addHook('onRequest', async (req) => {
    const portador = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const token = req.cookies[COOKIE] ?? portador;
    // Los tokens de servicio (Detector de leads) no son sesiones: los valida su propia guarda
    if (!token || token.startsWith('svc_')) return;
    const usuario = await usuarioDeToken(token);
    if (!usuario) return;
    req.tokenSesion = token;
    req.usuario = usuario;
  });

  async function usuarioDeToken(token: string): Promise<UsuarioSesion | null> {
    const sesion = await sesiones.obtener(token);
    if (!sesion) return null;
    const { rows } = await db.query<{ id: number; nombre: string; usuario: string; rol: Rol; sede_id: number | null }>(
      'SELECT id, nombre, usuario, rol, sede_id FROM usuarios WHERE id = $1 AND activo',
      [sesion.usuarioId],
    );
    const u = rows[0];
    if (!u) {
      await sesiones.destruir(token); // dado de baja mientras tenía la sesión abierta
      return null;
    }
    return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, sedeId: u.sede_id, permisos: await permisosEfectivos(db, u.id) };
  }
  app.decorate('usuarioDeToken', usuarioDeToken);

  /** Verifica usuario y clave con freno a la fuerza bruta; devuelve el token de una sesión nueva. */
  async function iniciarSesion(req: FastifyRequest): Promise<{ token: string; id: number }> {
    const { usuario, clave } = validar(
      z.object({ usuario: z.string().trim().toLowerCase().min(1), clave: z.string().min(1) }),
      req.body,
    );

    // Freno a la fuerza bruta: MAX_FALLOS_LOGIN intentos fallidos por usuario cada 15 minutos
    const claveFallos = `login_fallos:${usuario}`;
    const fallos = Number(await redis.get(claveFallos)) || 0;
    if (fallos >= MAX_FALLOS_LOGIN) {
      throw errorHttp(429, 'Demasiados intentos fallidos. Probá de nuevo en unos minutos.');
    }

    const { rows } = await db.query<{ id: number; password_hash: string; activo: boolean }>(
      'SELECT id, password_hash, activo FROM usuarios WHERE usuario = $1',
      [usuario],
    );
    const u = rows[0];
    const ok = u ? await verificarClave(u.password_hash, clave) : await simularVerificacion(clave);

    if (!u || !ok || !u.activo) {
      await redis.multi().incr(claveFallos).expire(claveFallos, VENTANA_FALLOS_SEG).exec();
      throw errorHttp(401, 'Usuario o clave incorrectos');
    }

    await redis.del(claveFallos);
    const token = await sesiones.crear(u.id);
    await db.query('UPDATE usuarios SET ultimo_acceso = now() WHERE id = $1', [u.id]);
    return { token, id: u.id };
  }

  app.post('/api/auth/login', async (req, reply) => {
    const { token, id } = await iniciarSesion(req);
    await registrarEnBitacora(db, { usuarioId: id, accion: 'sesion.iniciar', ip: req.ip });
    reply.setCookie(COOKIE, token, opcionesCookie);
    return { ok: true };
  });

  // Login de la extensión de Chrome: el token va en la respuesta y la extensión lo manda como
  // "Authorization: Bearer". Es una sesión común: vence igual y se cierra con /api/auth/salir.
  app.post('/api/auth/token', async (req) => {
    const { token, id } = await iniciarSesion(req);
    await registrarEnBitacora(db, { usuarioId: id, accion: 'sesion.iniciar', detalle: { cliente: 'extension' }, ip: req.ip });
    const { rows } = await db.query<{ nombre: string; rol: Rol }>('SELECT nombre, rol FROM usuarios WHERE id = $1', [id]);
    return { token, nombre: rows[0]!.nombre, rol: rows[0]!.rol };
  });

  app.post('/api/auth/salir', async (req, reply) => {
    if (req.tokenSesion) await sesiones.destruir(req.tokenSesion);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // Datos del usuario conectado: el frontend arma menús y el softphone con esto
  app.get('/api/auth/yo', { preHandler: requiereSesion }, async (req) => {
    const yo = usuarioDe(req);
    const { rows } = await db.query(
      `SELECT interno_sip, clave_sip, tipo_telefono, puede_marcar_manual, recibe_ivr,
              -- recibe leads si está en alguna regla de reparto activa (migración 010)
              EXISTS (SELECT 1 FROM leads_regla_vendedores rv JOIN leads_reglas r ON r.id = rv.regla_id AND r.activa
                       WHERE rv.usuario_id = usuarios.id) AS recibe_leads
         FROM usuarios WHERE id = $1`,
      [yo.id],
    );
    return {
      id: yo.id,
      nombre: yo.nombre,
      usuario: yo.usuario,
      rol: yo.rol,
      sedeId: yo.sedeId,
      permisos: [...yo.permisos].sort(),
      ...rows[0],
    };
  });

  // Cambio de la propia clave: cierra las demás sesiones abiertas
  app.post('/api/auth/clave', { preHandler: requiereSesion }, async (req, reply) => {
    const yo = usuarioDe(req);
    const { actual, nueva } = validar(z.object({ actual: z.string(), nueva: esquemaClave }), req.body);

    const { rows } = await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM usuarios WHERE id = $1',
      [yo.id],
    );
    if (!rows[0] || !(await verificarClave(rows[0].password_hash, actual))) {
      throw errorHttp(400, 'La clave actual no es correcta');
    }

    await db.query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [yo.id, await hashearClave(nueva)]);
    await sesiones.destruirDeUsuario(yo.id);
    reply.setCookie(COOKIE, await sesiones.crear(yo.id), opcionesCookie);
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'usuario.cambiar_clave_propia', ip: req.ip });
    return { ok: true };
  });
}
