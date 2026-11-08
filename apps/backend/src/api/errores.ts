// Errores HTTP y validación de entrada con zod.
// Fastify responde { statusCode, error, message } para cualquier error con statusCode < 500.
import type { z } from 'zod';

export function errorHttp(statusCode: number, mensaje: string): Error & { statusCode: number } {
  return Object.assign(new Error(mensaje), { statusCode });
}

export function validar<T>(esquema: z.ZodType<T, z.ZodTypeDef, unknown>, datos: unknown): T {
  const resultado = esquema.safeParse(datos);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw errorHttp(400, detalle);
  }
  return resultado.data;
}

/** Código de error de PostgreSQL (ej. '23505' = único violado, '23503' = FK). */
export function codigoPg(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

// Mensajes para las restricciones de la base que combinan columnas (las de un solo campo
// ya las frena zod antes). Los nombres son los que PostgreSQL generó en 001_esquema_inicial.sql.
const MENSAJES_RESTRICCION: Record<string, string> = {
  campanas_check: 'La tecla de No Llame no puede ser la misma que la de pase',
  campanas_check1: 'La hora de inicio tiene que ser anterior a la de fin',
  gateways_check: 'Los canales reservados para manual no pueden superar los canales del gateway',
  tipificaciones_check: 'Una tipificación de venta tiene que ser final',
  tipificaciones_check1: 'Una tipificación final no lleva minutos de reintento',
  horario_global_check: 'La hora de inicio tiene que ser anterior a la de fin',
  bloqueos_horario_check: 'Un bloqueo semanal lleva día de la semana; uno puntual, fecha',
  bloqueos_horario_check1: 'Indicá hora de inicio y de fin, o ninguna (todo el día)',
  bloqueos_horario_check2: 'La hora de inicio tiene que ser anterior a la de fin',
  usuarios_check: 'Un usuario inactivo necesita fecha de baja',
  // 005_avisos_ivr.sql
  campanas_teclas_aviso_distintas: 'Las teclas de llamada, WhatsApp y No Llame tienen que ser distintas',
  campanas_aviso_con_tecla: 'El IVR con aviso necesita la tecla de llamada, la de WhatsApp o las dos',
};

export function mensajeRestriccion(restriccion: string | undefined): string | undefined {
  return restriccion ? MENSAJES_RESTRICCION[restriccion] : undefined;
}
