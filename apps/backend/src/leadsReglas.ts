// Reglas de reparto de los leads del bot (migración 010): qué regla vale en un momento dado.
// Funciones puras, sin base ni configuración, para poder probarlas solas.

export interface ReglaLeads {
  id: number;
  nombre: string;
  por_defecto: boolean;
  dias: number[]; // 1 = lunes … 7 = domingo
  desde: string | null; // 'HH:MM' o 'HH:MM:SS'
  hasta: string | null;
  modo: 'conectadas' | 'todas';
  activa: boolean;
  orden: number;
  vendedores: number[];
}

const DIAS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Día de la semana (1–7) y minuto del día en la zona horaria de la oficina. */
export function momentoLocal(ahora: Date, zona: string): { dia: number; minuto: number } {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: zona, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(ahora);
  const valor = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return { dia: DIAS[valor('weekday')] ?? 1, minuto: Number(valor('hour')) * 60 + Number(valor('minute')) };
}

const aMinutos = (h: string) => {
  const [hh, mm] = h.split(':');
  return Number(hh) * 60 + Number(mm);
};

/**
 * ¿La regla vale en ese momento? Un horario que cruza la medianoche (21:00 a 09:00) cuenta para
 * el día en que empieza: el martes de 21:00 a 24:00 y el miércoles de 00:00 a 09:00 son de la regla
 * del martes.
 */
export function reglaVale(r: ReglaLeads, m: { dia: number; minuto: number }): boolean {
  if (!r.activa || r.por_defecto || !r.desde || !r.hasta) return false;
  const desde = aMinutos(r.desde);
  const hasta = aMinutos(r.hasta);
  if (desde < hasta) return r.dias.includes(m.dia) && m.minuto >= desde && m.minuto < hasta;
  const diaAnterior = m.dia === 1 ? 7 : m.dia - 1;
  return (r.dias.includes(m.dia) && m.minuto >= desde) || (r.dias.includes(diaAnterior) && m.minuto < hasta);
}

/** La regla que se aplica ahora: la primera (por orden) cuyo horario coincide, o la por defecto. */
export function reglaVigente(reglas: ReglaLeads[], ahora: Date, zona: string): ReglaLeads | null {
  const m = momentoLocal(ahora, zona);
  const ordenadas = [...reglas].sort((a, b) => a.orden - b.orden || a.id - b.id);
  return ordenadas.find((r) => reglaVale(r, m)) ?? ordenadas.find((r) => r.por_defecto && r.activa) ?? null;
}
