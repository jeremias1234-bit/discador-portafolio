// ¿Se puede marcar ahora? Horario global ∩ ventana y días de la campaña − bloqueos (§7).
import type pg from 'pg';

export interface Momento {
  dia: number; // ISO: 1 = lunes ... 7 = domingo
  hora: string; // 'HH:MM'
  fecha: string; // 'AAAA-MM-DD'
}

interface Franja {
  dia_semana: number;
  hora_inicio: string;
  hora_fin: string;
}

interface Bloqueo {
  tipo: 'semanal' | 'fecha';
  dia_semana: number | null;
  fecha: string | null;
  hora_inicio: string | null;
  hora_fin: string | null;
  campana_id: number | null;
  motivo: string;
}

export interface ReglasHorario {
  global: Franja[];
  bloqueos: Bloqueo[];
}

export interface VentanaCampana {
  id: number;
  hora_inicio: string;
  hora_fin: string;
  dias_semana: number[];
}

const DIAS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function momentoEn(zona: string, fecha = new Date()): Momento {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    })
      .formatToParts(fecha)
      .map((p) => [p.type, p.value]),
  );
  return {
    dia: DIAS[partes.weekday!]!,
    hora: `${partes.hour}:${partes.minute}`,
    fecha: `${partes.year}-${partes.month}-${partes.day}`,
  };
}

export async function cargarReglas(db: pg.Pool): Promise<ReglasHorario> {
  const [global, bloqueos] = await Promise.all([
    db.query<Franja>(
      `SELECT dia_semana, to_char(hora_inicio, 'HH24:MI') AS hora_inicio, to_char(hora_fin, 'HH24:MI') AS hora_fin
         FROM horario_global`,
    ),
    db.query<Bloqueo>(
      `SELECT tipo, dia_semana, fecha::text AS fecha, to_char(hora_inicio, 'HH24:MI') AS hora_inicio,
              to_char(hora_fin, 'HH24:MI') AS hora_fin, campana_id, motivo
         FROM bloqueos_horario WHERE activo`,
    ),
  ]);
  return { global: global.rows, bloqueos: bloqueos.rows };
}

const dentro = (hora: string, inicio: string, fin: string) => inicio <= hora && hora < fin;

/** null = se puede marcar; si no, el motivo. Sin campaña = solo horario global y bloqueos generales. */
export function motivoFueraDeHorario(reglas: ReglasHorario, m: Momento, campana?: VentanaCampana): string | null {
  if (!reglas.global.some((f) => f.dia_semana === m.dia && dentro(m.hora, f.hora_inicio, f.hora_fin))) {
    return 'fuera del horario global';
  }
  if (campana) {
    if (!campana.dias_semana.includes(m.dia)) return 'la campaña no trabaja hoy';
    if (!dentro(m.hora, campana.hora_inicio, campana.hora_fin)) return 'fuera de la ventana de la campaña';
  }
  const bloqueo = reglas.bloqueos.find(
    (b) =>
      (b.campana_id === null || b.campana_id === campana?.id) &&
      (b.tipo === 'semanal' ? b.dia_semana === m.dia : b.fecha === m.fecha) &&
      (b.hora_inicio === null || dentro(m.hora, b.hora_inicio, b.hora_fin!)),
  );
  return bloqueo ? `bloqueo: ${bloqueo.motivo}` : null;
}
