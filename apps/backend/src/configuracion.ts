// Parámetros globales (§16): tipo, rango y permiso de cada clave de la tabla `configuracion`.
// El motor y la API leen de acá; una clave que no está en este catálogo no se puede editar.
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { z } from 'zod';
import { CANAL_EVENTOS, type Evento } from './eventos.js';

const entero = (min: number, max: number) => z.number().int().min(min).max(max);

export const PARAMETROS = {
  'general.zona_horaria': { esquema: z.string().min(3).max(64), permiso: 'config.horario' },
  'general.vendedor_solo_su_campana': { esquema: z.boolean(), permiso: 'config.ritmo' },

  'ritmo.llamadas_por_vendedor': { esquema: z.number().positive().max(20), permiso: 'config.ritmo' },
  'ritmo.abandono_objetivo_pct': { esquema: z.number().min(0).max(100), permiso: 'config.ritmo' },
  'ritmo.muestras_minimas': { esquema: entero(1, 100_000), permiso: 'config.ritmo' },
  'ritmo.rafaga_por_ciclo': { esquema: entero(1, 200), permiso: 'config.ritmo' },
  'ritmo.limite_por_minuto': { esquema: entero(1, 10_000), permiso: 'config.ritmo' },
  'ritmo.adaptativo': { esquema: z.boolean(), permiso: 'config.ritmo' },
  'ritmo.recuento_campanas_seg': { esquema: entero(1, 60), permiso: 'config.ritmo' },
  'ritmo.aviso_llamada_larga_min': { esquema: entero(1, 600), permiso: 'config.ritmo' },
  'ritmo.aviso_base_por_acabarse': { esquema: entero(0, 1_000_000), permiso: 'config.ritmo' },
  // Guía para el predictivo: cuánto debería esperar un vendedor entre llamadas (el monitor lo marca)
  'ritmo.espera_objetivo_min_seg': { esquema: entero(0, 3600), permiso: 'config.ritmo' },
  'ritmo.espera_objetivo_max_seg': { esquema: entero(1, 3600), permiso: 'config.ritmo' },

  // Parámetros de AMD() de Asterisk, en el mismo orden en que los recibe la aplicación
  'amd.silencio_inicial_ms': { esquema: entero(100, 10_000), permiso: 'config.amd' },
  'amd.saludo_max_ms': { esquema: entero(100, 10_000), permiso: 'config.amd' },
  'amd.silencio_tras_saludo_ms': { esquema: entero(100, 10_000), permiso: 'config.amd' },
  'amd.tiempo_total_ms': { esquema: entero(500, 30_000), permiso: 'config.amd' },
  'amd.palabra_min_ms': { esquema: entero(10, 5_000), permiso: 'config.amd' },
  'amd.silencio_entre_palabras_ms': { esquema: entero(10, 5_000), permiso: 'config.amd' },
  'amd.palabras_maquina': { esquema: entero(1, 20), permiso: 'config.amd' },
  'amd.umbral_silencio': { esquema: entero(1, 32_767), permiso: 'config.amd' },
  'amd.palabra_max_ms': { esquema: entero(100, 30_000), permiso: 'config.amd' },
  'amd.pasar_dudosas': { esquema: z.boolean(), permiso: 'config.amd' },
  // Graba los segundos de la detección para revisar si el AMD acertó (Revisión de AMD)
  'amd.grabar_deteccion': { esquema: z.boolean(), permiso: 'config.amd' },

  // El vigilante de canales corta las llamadas que superan esta duración
  'llamadas.duracion_max_min': { esquema: entero(1, 600), permiso: 'config.ritmo' },

  'ivr.prioridad_en_cola': { esquema: z.boolean(), permiso: 'ivr.editar' },

  // Detector de leads del bot de WhatsApp: textos del bot que, al responderlos el cliente, generan
  // el lead (se comparan normalizados: minúsculas, sin acentos, emojis ni signos)
  'leads.disparadores_portabilidad': { esquema: z.array(z.string().trim().min(3).max(300)).max(20), permiso: 'leads.editar' },
  'leads.disparadores_fibra': { esquema: z.array(z.string().trim().min(3).max(300)).max(20), permiso: 'leads.editar' },
  // Solo los clientes de estas compañías generan lead (vacío = todas)
  'leads.companias': { esquema: z.array(z.string().trim().min(2).max(40)).max(10), permiso: 'leads.editar' },
  // Un mismo número genera un solo lead en esta ventana (los mensajes siguientes lo completan)
  'leads.horas_deduplicacion': { esquema: entero(1, 720), permiso: 'leads.editar' },
  // Al abrir WhatsApp Web no se disparan mensajes más viejos que esto
  'leads.antiguedad_max_min': { esquema: entero(1, 1440), permiso: 'leads.editar' },

  'tipificacion.obligatoria': { esquema: z.boolean(), permiso: 'config.tipificacion' },
  'tipificacion.pendientes_horas': { esquema: entero(1, 720), permiso: 'config.tipificacion' },
  'tipificacion.duracion_minima_seg': { esquema: entero(0, 600), permiso: 'config.tipificacion' },

  'grabaciones.retencion_dias': { esquema: entero(1, 3650), permiso: 'config.grabaciones' },
  'grabaciones.piso_disco_libre_gb': { esquema: entero(1, 10_000), permiso: 'config.grabaciones' },
  'grabaciones.por_pagina': { esquema: entero(10, 500), permiso: 'config.grabaciones' },

  'no_llame.alerta_dias_padron': { esquema: entero(1, 365), permiso: 'config.no_llame' },

  'telefono.tono_entrada': { esquema: z.boolean(), permiso: 'config.ritmo' },
  'telefono.volumen_inicial': { esquema: z.number().min(0).max(1), permiso: 'config.ritmo' },
} as const satisfies Record<string, { esquema: z.ZodTypeAny; permiso: string }>;

export type ClaveConfig = keyof typeof PARAMETROS;
export type Config = { [K in ClaveConfig]: z.infer<(typeof PARAMETROS)[K]['esquema']> };

export function esClaveConfig(clave: string): clave is ClaveConfig {
  return Object.hasOwn(PARAMETROS, clave);
}

export async function leerConfiguracion(db: pg.Pool): Promise<Config> {
  const { rows } = await db.query<{ clave: string; valor: unknown }>('SELECT clave, valor FROM configuracion');
  const valores = new Map(rows.map((r) => [r.clave, r.valor]));
  const config = {} as Record<string, unknown>;
  for (const [clave, def] of Object.entries(PARAMETROS)) {
    const r = def.esquema.safeParse(valores.get(clave));
    if (!r.success) throw new Error(`Configuración inválida o faltante: ${clave}`);
    config[clave] = r.data;
  }
  return config as Config;
}

/** Copia en memoria de la configuración, recargada al recibir 'config.actualizada'. */
export class CacheConfiguracion {
  private actual?: Config;

  constructor(
    private readonly db: pg.Pool,
    suscriptor: Redis,
  ) {
    suscriptor.on('message', (canal: string, mensaje: string) => {
      if (canal !== CANAL_EVENTOS) return;
      const evento = JSON.parse(mensaje) as Evento;
      if (evento.tipo === 'config.actualizada') void this.recargar();
    });
  }

  async recargar(): Promise<Config> {
    this.actual = await leerConfiguracion(this.db);
    return this.actual;
  }

  async obtener(): Promise<Config> {
    return this.actual ?? this.recargar();
  }
}
