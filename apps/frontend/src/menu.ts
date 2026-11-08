// Secciones del panel y quién las ve. El backend vuelve a controlar cada permiso.
// La primera sección del menú es la pantalla de inicio: el vendedor entra a su puesto
// y el supervisor y el admin al monitor.
import type { Yo } from './tipos';

export interface Seccion {
  ruta: string;
  texto: string;
  /** Las de administración van agrupadas en un desplegable para que el menú entre en pantalla. */
  grupo?: 'admin';
}

/** Puede abrir una línea para llamar a mano (el admin siempre). */
export function puedeLlamar(yo: Yo): boolean {
  return !!yo.interno_sip && (yo.rol === 'admin' || yo.puede_marcar_manual);
}

export function menuDe(yo: Yo, puede: (...p: string[]) => boolean): Seccion[] {
  const m: Seccion[] = [];
  if (yo.rol === 'vendedor' && yo.interno_sip) {
    m.push({ ruta: '/puesto', texto: 'Puesto' });
    m.push({ ruta: '/mis-llamadas', texto: 'Mis llamadas' });
  }
  if (yo.rol === 'vendedor' && (yo.recibe_ivr || yo.recibe_leads)) m.push({ ruta: '/mis-avisos', texto: 'Mis avisos' });
  if (puede('monitor.ver')) m.push({ ruta: '/monitor', texto: 'Monitor' });
  if (puede('ivr.ver', 'ivr.avisos')) m.push({ ruta: '/ivr', texto: 'IVR' });
  if (puede('leads.ver', 'leads.editar')) m.push({ ruta: '/leads', texto: 'Leads' });
  if (puede('reportes.ver')) m.push({ ruta: '/reportes', texto: 'Reportes' });
  if (puede('grabaciones.escuchar')) m.push({ ruta: '/grabaciones', texto: 'Grabaciones' });
  if (puede('config.amd')) m.push({ ruta: '/revision-amd', texto: 'Revisión AMD' });
  if (puede('campanas.ver', 'ivr.ver')) m.push({ ruta: '/campanas', texto: 'Campañas', grupo: 'admin' });
  if (puede('usuarios.administrar', 'vendedores.ver')) m.push({ ruta: '/usuarios', texto: 'Usuarios', grupo: 'admin' });
  if (puede('campanas.ver', 'ivr.ver')) m.push({ ruta: '/audios', texto: 'Audios', grupo: 'admin' });
  if (puede('gateways.ver')) m.push({ ruta: '/gateways', texto: 'Gateways', grupo: 'admin' });
  if (puede('config.ritmo', 'config.amd', 'config.tipificacion', 'config.horario', 'config.descansos', 'config.sedes', 'config.grabaciones', 'ivr.editar')) {
    m.push({ ruta: '/configuracion', texto: 'Configuración', grupo: 'admin' });
  }
  if (puede('config.no_llame')) m.push({ ruta: '/no-llame', texto: 'No Llame', grupo: 'admin' });
  if (puede('bitacora.ver')) m.push({ ruta: '/bitacora', texto: 'Bitácora', grupo: 'admin' });
  // Supervisor o admin que también llama: al final, como una opción más
  if (yo.rol !== 'vendedor' && puedeLlamar(yo)) m.push({ ruta: '/puesto', texto: 'Llamar' });
  return m;
}
