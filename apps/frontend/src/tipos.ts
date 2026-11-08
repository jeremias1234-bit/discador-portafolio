// Tipos de las respuestas del backend que usa el panel.

export type Rol = 'vendedor' | 'supervisor' | 'admin';
export type EstadoPuesto = 'disponible' | 'en_llamada' | 'tipificando' | 'descanso';

export interface Yo {
  id: number;
  nombre: string;
  usuario: string;
  rol: Rol;
  sedeId: number | null;
  permisos: string[];
  interno_sip: string | null;
  clave_sip: string | null;
  tipo_telefono: 'navegador' | 'externo';
  puede_marcar_manual: boolean;
  recibe_ivr: boolean;
  recibe_leads: boolean;
}

export interface CampanaAsignada {
  id: number;
  nombre: string;
  tipo: 'manual' | 'progresivo' | 'predictivo' | 'predictivo_audio' | 'ivr';
}

export interface EstadoDelPuesto {
  linea_conectada: boolean;
  recibe_ivr: boolean | null;
  estado: EstadoPuesto | null;
  motivo_descanso_id: number | null;
  desde: number | null;
  llamada_id: number | null;
  ultima_llamada_id: number | null;
  pendientes_de_tipificar: number;
  tipificacion_obligatoria: boolean;
  tono_entrada: boolean;
  volumen_inicial: number;
  campanas: CampanaAsignada[];
}

export interface Lead {
  id: number;
  nombre: string | null;
  telefono: string;
  dni: string | null;
  datos: Record<string, unknown>;
  intentos: number;
  ultimo_resultado: string | null;
}

export interface Ficha {
  llamada_id: number;
  telefono: string;
  origen: 'discador' | 'manual' | 'ivr';
  campana: { id: number; nombre: string; tipo: CampanaAsignada['tipo'] } | null;
  lead: Lead | null;
  tecla_ivr: string | null;
}

export interface Tipificacion {
  id: number;
  nombre: string;
  es_final: boolean;
  es_venta: boolean;
  es_contestador: boolean;
  reintentar_en_min: number | null;
  marca_no_llame: boolean;
  orden: number;
  activa: boolean;
}

export interface MotivoDescanso {
  id: number;
  nombre: string;
  max_minutos: number | null;
  orden: number;
  visible: boolean;
  activo: boolean;
}

export interface Pendiente {
  id: number;
  telefono: string;
  inicio: string;
  fin: string;
  campana_id: number | null;
  campana: string | null;
  lead_nombre: string | null;
  duracion_seg: number | null;
}

/** Mensajes del canal 'puesto' del WebSocket. */
export type MensajePuesto =
  | { canal: 'puesto'; tipo: 'hola'; linea_conectada: boolean; estado: EstadoPuesto | null }
  | { canal: 'puesto'; tipo: 'linea'; conectada: boolean; estado?: EstadoPuesto }
  | { canal: 'puesto'; tipo: 'estado'; estado: EstadoPuesto; motivo_descanso_id: number | null }
  | { canal: 'puesto'; tipo: 'llamada_conectada'; ficha: Ficha }
  | { canal: 'puesto'; tipo: 'llamada_terminada'; llamada_id: number; resultado: string; conectada: boolean; debe_tipificar: boolean };
