// Fondo de la extensión: espera los avisos nuevos, los notifica con un sonido y deja en el ícono
// la cantidad de pendientes. Dos colas: leads del bot de WhatsApp (notificación verde, sonido propio
// y fija hasta que la vendedora la toca: el cliente está escribiendo ahora) y avisos del IVR.
//
// Usa long polling (/api/avisos/esperar) y no un WebSocket: Chrome no deja que una extensión abra
// un WebSocket hacia una IP de la red local, pero sí pedidos HTTP con permiso de host. El servidor
// retiene cada pedido hasta que llega un aviso o pasan 25 s, y se vuelve a pedir enseguida.
// Cada vuelta llama a la API de la extensión (storage), lo que mantiene despierto al service
// worker; si igual Chrome lo duerme, la alarma de cada 30 s lo despierta y retoma la espera.
import { api, leerPreferencias, leerSesion, productoDe, SesionVencida, formatoTelefono, TEXTO_CONTACTO, TEXTO_PRODUCTO } from './comun.js';

let esperando = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.alarms.create('vigilar', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void vigilar());
chrome.runtime.onStartup.addListener(() => void vigilar());
chrome.storage.onChanged.addListener((cambios, area) => {
  if (area === 'local' && 'sesion' in cambios) {
    void chrome.storage.session.remove('ultimo');
    void vigilar();
  }
});
chrome.runtime.onMessage.addListener((m) => {
  if (m?.tipo === 'refrescar') void actualizarIcono();
});

async function fijarEstado(conexion) {
  await chrome.storage.session.set({ conexion });
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function vigilar() {
  const sesion = await leerSesion();
  if (!sesion) {
    await fijarEstado('sin_sesion');
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  await actualizarIcono();
  if (!esperando) void esperarAvisos();
}

async function esperarAvisos() {
  esperando = true;
  try {
    while (await leerSesion()) {
      try {
        let { ultimo } = await chrome.storage.session.get('ultimo');
        if (ultimo === undefined) {
          // Punto de partida: los avisos que ya estaban no se notifican de nuevo
          ({ ultimo } = await api('/api/avisos/esperar'));
          await chrome.storage.session.set({ ultimo });
        }
        await fijarEstado('conectado');
        const r = await api(`/api/avisos/esperar?ultimo=${ultimo}`);
        await chrome.storage.session.set({ ultimo: r.ultimo });
        for (const aviso of r.avisos) await avisoNuevo(aviso);
        // Cambió uno de sus avisos (el Detector completó el DNI, lo cerraron desde el panel…)
        if (r.cambio) {
          await actualizarIcono();
          chrome.runtime.sendMessage({ tipo: 'avisos' }).catch(() => {});
        }
      } catch (err) {
        if (err instanceof SesionVencida) break;
        await fijarEstado('desconectado');
        await pausa(5000);
      }
    }
    await fijarEstado('sin_sesion');
  } finally {
    esperando = false;
  }
}

async function avisoNuevo(aviso) {
  const esLead = (aviso.origen ?? 'ivr') === 'whatsapp';
  const producto = productoDe(aviso);
  const etiqueta = producto ? `${TEXTO_PRODUCTO[producto]} · ` : '';
  let titulo;
  let mensaje;
  if (esLead) {
    // "🟢 LEAD · PORTA · 11 2345-6789" / "Juan Pérez · Claro · DNI 30123456"
    titulo = `🟢 LEAD · ${etiqueta}${formatoTelefono(aviso.telefono)}`;
    mensaje = [aviso.nombre, aviso.compania, aviso.dni ? `DNI ${aviso.dni}` : 'revisar DNI'].filter(Boolean).join(' · ');
  } else {
    titulo = `${aviso.contacto === 'whatsapp' ? '💬' : '📞'} ${etiqueta}${TEXTO_CONTACTO[aviso.contacto]}: ${formatoTelefono(aviso.telefono)}`;
    mensaje = [aviso.nombre, aviso.campana].filter(Boolean).join(' · ') || 'Cliente del IVR';
  }
  chrome.notifications.create(`aviso-${aviso.id}`, {
    type: 'basic',
    iconUrl: 'iconos/icono-128.png',
    title: titulo,
    message: mensaje,
    priority: 2,
    requireInteraction: true,
  });
  const pref = await leerPreferencias();
  if (esLead ? pref.sonidoLeads : pref.sonidoIvr) void sonar(esLead ? 'lead' : 'ivr');
  await actualizarIcono();
  chrome.runtime.sendMessage({ tipo: 'avisos' }).catch(() => {}); // el panel, si está abierto
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const [ventana] = await chrome.windows.getAll({ windowTypes: ['normal'] });
  try {
    await chrome.sidePanel.open({ windowId: ventana.id });
  } catch {
    await chrome.windows.create({ url: 'panel.html', type: 'popup', width: 420, height: 700 });
  }
});

async function actualizarIcono() {
  try {
    const { pendientes } = await api('/api/avisos/mios');
    // Total de las dos pestañas; verde WhatsApp si hay algún lead esperando
    const hayLeads = pendientes.some((a) => a.origen === 'whatsapp');
    await chrome.action.setBadgeBackgroundColor({ color: hayLeads ? '#25d366' : '#d9534f' });
    await chrome.action.setBadgeText({ text: pendientes.length ? String(pendientes.length) : '' });
  } catch (err) {
    if (!(err instanceof SesionVencida)) await chrome.action.setBadgeText({ text: '' });
  }
}

/** El sonido se reproduce desde un documento oculto (el service worker no tiene audio). */
async function sonar(estilo) {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({ url: 'sonido.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Avisar un cliente nuevo' });
    }
    await chrome.runtime.sendMessage({ tipo: 'sonar', estilo });
  } catch {
    /* sin sonido: queda la notificación */
  }
}

void vigilar();
