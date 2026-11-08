// Eventos internos por Redis pub/sub (canal 'eventos'): el motor recarga la configuración
// en caliente y el monitor reenvía lo que corresponda a los WebSockets del frontend.
import type { Redis } from 'ioredis';

export const CANAL_EVENTOS = 'eventos';

export interface Evento {
  tipo: string; // ej. 'campana.actualizada', 'config.actualizada'
  datos?: Record<string, unknown>;
}

export async function publicarEvento(redis: Redis, tipo: string, datos?: Record<string, unknown>): Promise<void> {
  await redis.publish(CANAL_EVENTOS, JSON.stringify({ tipo, datos } satisfies Evento));
}
