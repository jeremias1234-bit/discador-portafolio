// Sesiones del panel guardadas en Redis. La cookie solo lleva un token aleatorio.
//   sesion:{token}            -> JSON de la sesión, con vencimiento que se renueva al usarla
//   sesiones_usuario:{id}     -> set de tokens del usuario, para cerrarlas todas (baja, cambio de clave)
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface Sesion {
  usuarioId: number;
  creadaEn: number;
}

export class Sesiones {
  constructor(
    private readonly redis: Redis,
    private readonly duracionSeg: number,
  ) {}

  async crear(usuarioId: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const sesion: Sesion = { usuarioId, creadaEn: Date.now() };
    await this.redis
      .multi()
      .set(`sesion:${token}`, JSON.stringify(sesion), 'EX', this.duracionSeg)
      .sadd(`sesiones_usuario:${usuarioId}`, token)
      .exec();
    return token;
  }

  /** Devuelve la sesión y renueva su vencimiento; null si no existe o venció. */
  async obtener(token: string): Promise<Sesion | null> {
    const clave = `sesion:${token}`;
    const datos = await this.redis.getex(clave, 'EX', this.duracionSeg);
    return datos ? (JSON.parse(datos) as Sesion) : null;
  }

  async destruir(token: string): Promise<void> {
    const sesion = await this.obtener(token);
    const tx = this.redis.multi().del(`sesion:${token}`);
    if (sesion) tx.srem(`sesiones_usuario:${sesion.usuarioId}`, token);
    await tx.exec();
  }

  async destruirDeUsuario(usuarioId: number): Promise<void> {
    const claveSet = `sesiones_usuario:${usuarioId}`;
    const tokens = await this.redis.smembers(claveSet);
    await this.redis.del(claveSet, ...tokens.map((t) => `sesion:${t}`));
  }
}
