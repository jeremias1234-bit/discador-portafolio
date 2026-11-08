// Fondo del Detector: recibe los leads que detecta el lector en WhatsApp Web y los manda al
// discador con el token de servicio. Si el discador no responde, quedan en cola y se reintentan
// cada 30 s: nunca se pierde un lead. Cada minuto manda un latido (el panel muestra si el Detector
// está vivo) y trae del panel los textos disparadores.
//
// Guarda solo lo indispensable: la cola de envíos, la configuración y un registro de los últimos
// 100 eventos con el número enmascarado. Nada de las conversaciones.
import { leerAjustes } from './comun.js';

const MAX_REGISTRO = 100;
const LATIDO_VIEJO_MS = 2 * 60_000;

chrome.alarms.create('latido', { periodInMinutes: 1 });
chrome.alarms.create('cola', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'latido') void latido();
  if (a.name === 'cola') void procesarCola();
});
chrome.runtime.onStartup.addListener(() => void latido());
chrome.runtime.onInstalled.addListener(() => void latido());

const enmascarar = (t) => (t ? `••••${String(t).slice(-4)}` : '—');
const hoy = () => new Date().toLocaleDateString('sv-SE');

async function registrar(e) {
  const { registro = [] } = await chrome.storage.local.get('registro');
  registro.unshift({ en: new Date().toISOString(), ...e });
  await chrome.storage.local.set({ registro: registro.slice(0, MAX_REGISTRO) });
}

async function sumarEnviado() {
  const { contador } = await chrome.storage.local.get('contador');
  const c = contador?.fecha === hoy() ? contador : { fecha: hoy(), n: 0 };
  c.n++;
  await chrome.storage.local.set({ contador: c });
}

async function enviadosHoy() {
  const { contador } = await chrome.storage.local.get('contador');
  return contador?.fecha === hoy() ? contador.n : 0;
}

async function pedir(ruta, { metodo = 'GET', cuerpo } = {}) {
  const a = await leerAjustes();
  if (!a.servidor || !a.token) throw new Error('Falta configurar el servidor o el token');
  const r = await fetch(a.servidor.replace(/\/+$/, '') + ruta, {
    method: metodo,
    headers: { Authorization: `Bearer ${a.token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(datos.message ?? `Error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return datos;
}

// --- Mensajes del lector (vía puente.js) ---

chrome.runtime.onMessage.addListener((m, remitente, responder) => {
  if (m?.tipo === 'lead') void encolar(m.datos);
  else if (m?.tipo === 'estado') void chrome.storage.local.set({ lector: { ...m.datos, en: Date.now() } }).then(actualizarIcono);
  else if (m?.tipo === 'evento') void registrar({ tipo: 'info', texto: m.datos?.texto ?? '' });
  else if (m?.tipo === 'sin_wpp' && remitente.tab?.id) void inyectarWaJs(remitente.tab.id);
  else if (m?.tipo === 'probar') {
    void probarEnvio().then(responder, (err) => responder({ ok: false, error: err.message }));
    return true; // respuesta asincrónica
  } else if (m?.tipo === 'latido_ya') void latido();
  else if (m?.tipo === 'ajustes_cambiados') void actualizarIcono();
  return false;
});

/** WhatsApp Web no tenía wa-js (TURBO BOT no la cargó): se inyecta la copia de la extensión. */
async function inyectarWaJs(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/wppconnect-wa.js'] });
    await registrar({ tipo: 'info', texto: 'Se cargó wa-js en WhatsApp Web' });
  } catch (err) {
    await registrar({ tipo: 'error', texto: `No se pudo cargar wa-js: ${err.message}` });
  }
}

async function encolar(lead) {
  if (!lead?.telefono) return;
  const a = await leerAjustes();
  if (a.pausado) return;
  const { cola = [] } = await chrome.storage.local.get('cola');
  cola.push({ ...lead, pc_bot: a.pc, encolado_en: Date.now(), intentos: 0 });
  await chrome.storage.local.set({ cola });
  await procesarCola();
}

let procesando = false;
async function procesarCola() {
  if (procesando) return;
  procesando = true;
  try {
    for (;;) {
      const { cola = [] } = await chrome.storage.local.get('cola');
      const item = cola[0];
      if (!item) break;
      // Reintento con espera creciente (30 s, 1 min, 2 min… hasta 10 min) si el discador no respondió
      const espera = Math.min(600_000, 30_000 * 2 ** Math.max(0, item.intentos - 1));
      if (item.intentos > 0 && Date.now() - (item.ultimo_intento ?? 0) < espera) break;
      const { encolado_en: _e, intentos: _i, ultimo_intento: _u, ...lead } = item;
      try {
        const r = await pedir('/api/leads', { metodo: 'POST', cuerpo: lead });
        cola.shift();
        await chrome.storage.local.set({ cola });
        if (r.nuevo) await sumarEnviado();
        await registrar({
          tipo: 'ok',
          texto: `${r.nuevo ? 'Lead nuevo' : 'Lead completado'} ${enmascarar(lead.telefono)} · ${lead.interes ?? '?'} · DNI ${lead.dni ? 'sí' : 'no'}${r.vendedor ? ` → ${r.vendedor}` : ''}`,
        });
      } catch (err) {
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          // El discador lo rechazó (dato inválido): no tiene sentido reintentar
          cola.shift();
          await chrome.storage.local.set({ cola });
          await registrar({ tipo: 'error', texto: `Rechazado ${enmascarar(lead.telefono)}: ${err.message}` });
          continue;
        }
        cola[0] = { ...item, intentos: item.intentos + 1, ultimo_intento: Date.now() };
        await chrome.storage.local.set({ cola });
        if (item.intentos === 0) await registrar({ tipo: 'error', texto: `Sin conexión con el discador (queda en cola): ${err.message}` });
        break;
      }
    }
  } finally {
    procesando = false;
    await actualizarIcono();
  }
}

async function latido() {
  const { lector, cola = [] } = await chrome.storage.local.get(['lector', 'cola']);
  const modo = lector && Date.now() - lector.en < LATIDO_VIEJO_MS ? lector.modo : 'caido';
  const a = await leerAjustes();
  try {
    await pedir('/api/leads/latido', {
      metodo: 'POST',
      cuerpo: { pc_bot: a.pc, version: `${chrome.runtime.getManifest().version} / wa-js ${lector?.version ?? '?'}`, modo, enviados_hoy: await enviadosHoy(), en_cola: cola.length },
    });
    const reglas = await pedir('/api/leads/config');
    await chrome.storage.local.set({ reglas, conexion: { ok: true, en: Date.now() } });
  } catch (err) {
    await chrome.storage.local.set({ conexion: { ok: false, en: Date.now(), error: err.message } });
  }
  await procesarCola();
}

async function probarEnvio() {
  const a = await leerAjustes();
  await pedir('/api/leads', { metodo: 'POST', cuerpo: { telefono: '1100000000', prueba: true, pc_bot: a.pc } });
  await latido();
  return { ok: true };
}

async function actualizarIcono() {
  const { lector, cola = [], conexion } = await chrome.storage.local.get(['lector', 'cola', 'conexion']);
  const a = await leerAjustes();
  const vivo = lector && Date.now() - lector.en < LATIDO_VIEJO_MS && lector.modo === 'principal';
  const mal = !vivo || cola.length > 0 || conexion?.ok === false;
  const n = await enviadosHoy();
  await chrome.action.setBadgeBackgroundColor({ color: a.pausado ? '#8a8a8a' : mal ? '#e5534b' : '#25d366' });
  await chrome.action.setBadgeText({ text: a.pausado ? 'II' : cola.length ? `!${cola.length}` : !vivo ? '!' : n ? String(n) : '' });
  await chrome.action.setTitle({
    title: a.pausado ? 'Detector en pausa'
      : !vivo ? 'Detector caído: no está leyendo WhatsApp Web (¿está abierto?)'
        : cola.length ? `${cola.length} lead(s) esperando para mandarse`
          : `Detector andando · ${n} lead(s) hoy`,
  });
}

void latido();
