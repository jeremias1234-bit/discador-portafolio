// Sesión guardada y llamadas a la API, compartidas por el fondo y el panel.

/** { servidor, token, nombre } o null */
export async function leerSesion() {
  const { sesion } = await chrome.storage.local.get('sesion');
  return sesion ?? null;
}

export async function guardarSesion(sesion) {
  if (sesion) await chrome.storage.local.set({ sesion });
  else await chrome.storage.local.remove('sesion');
}

export class SesionVencida extends Error {}

export async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
  const sesion = await leerSesion();
  if (!sesion) throw new SesionVencida('Sin sesión');
  const r = await fetch(sesion.servidor + ruta, {
    method: metodo,
    headers: { Authorization: `Bearer ${sesion.token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (r.status === 401) {
    await guardarSesion(null);
    throw new SesionVencida('La sesión venció: volvé a ingresar');
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(datos.message ?? `Error ${r.status}`);
  return datos;
}

/** 2617256360 -> "261 725-6360" (característica de 2, 3 o 4 dígitos: se muestra simple) */
export function formatoTelefono(t) {
  if (!/^\d{10}$/.test(t)) return t;
  return t.startsWith('11') ? `11 ${t.slice(2, 6)}-${t.slice(6)}` : `${t.slice(0, 3)} ${t.slice(3, 6)}-${t.slice(6)}`;
}

/** WhatsApp de un celular argentino: 54 9 + los 10 dígitos */
export function enlaceWhatsapp(t) {
  return `https://web.whatsapp.com/send?phone=549${t}`;
}

export const TEXTO_CONTACTO = { llamada: 'Llamada', whatsapp: 'WhatsApp' };

/**
 * Producto del aviso, para la etiqueta de color: el interés del lead del bot, o en los del IVR el
 * comienzo del nombre de la campaña ("FIBRA - AMBA 05/11" -> fibra, "PORTA ..." -> portabilidad).
 */
export function productoDe(aviso) {
  if (aviso.interes) return aviso.interes;
  const c = (aviso.campana ?? '').trim().toUpperCase();
  if (c.startsWith('FIBRA')) return 'fibra';
  if (c.startsWith('PORTA')) return 'portabilidad';
  return null;
}
export const TEXTO_PRODUCTO = { portabilidad: 'PORTA', fibra: 'FIBRA' };

/** Preferencias de la vendedora (sonido por pestaña). Por defecto suena todo. */
export async function leerPreferencias() {
  const { preferencias } = await chrome.storage.local.get('preferencias');
  return { sonidoLeads: true, sonidoIvr: true, ...(preferencias ?? {}) };
}
