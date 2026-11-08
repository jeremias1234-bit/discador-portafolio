// Ajustes del Detector, compartidos por el fondo y la pantalla de opciones.
import { SERVIDOR_POR_DEFECTO } from './config.js';

/** { servidor, token, pc, pausado } */
export async function leerAjustes() {
  const { ajustes } = await chrome.storage.local.get('ajustes');
  return { servidor: SERVIDOR_POR_DEFECTO, token: '', pc: 'PC del bot', pausado: false, ...(ajustes ?? {}) };
}

export async function guardarAjustes(cambios) {
  const actuales = await leerAjustes();
  await chrome.storage.local.set({ ajustes: { ...actuales, ...cambios } });
}
