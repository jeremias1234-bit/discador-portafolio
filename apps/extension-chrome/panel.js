// Panel lateral: ingreso y avisos en dos pestañas separadas, LEADS (bot de WhatsApp) e IVR, cada
// una con sus pendientes e historial. Los números de los circulitos bajan apenas se marca
// Contactado o Descartar.
import { SERVIDOR_POR_DEFECTO } from './config.js';
import {
  api, enlaceWhatsapp, formatoTelefono, guardarSesion, leerPreferencias, leerSesion, productoDe, SesionVencida,
  TEXTO_CONTACTO, TEXTO_PRODUCTO,
} from './comun.js';

const $ = (id) => document.getElementById(id);
let origen = 'whatsapp';
let vista = 'pendientes';
let datos = { pendientes: [], recientes: [] };

const ESTADO_CONEXION = {
  conectado: ['Conectado', 'ok'],
  conectando: ['Conectando…', ''],
  desconectado: ['Sin conexión', 'mal'],
  sin_sesion: ['', ''],
};

async function mostrarConexion() {
  const { conexion } = await chrome.storage.session.get('conexion');
  const [texto, clase] = ESTADO_CONEXION[conexion] ?? ['', ''];
  $('conexion').textContent = texto;
  $('conexion').className = `chip ${clase}`;
  $('conexion').hidden = !texto;
}

async function iniciar() {
  const sesion = await leerSesion();
  $('ingreso').hidden = !!sesion;
  $('principal').hidden = !sesion;
  $('usuario').textContent = `${sesion?.nombre ?? ''} · v${chrome.runtime.getManifest().version}`;
  if (!sesion) {
    const { ultimoServidor } = await chrome.storage.local.get('ultimoServidor');
    $('servidor').value = ultimoServidor || SERVIDOR_POR_DEFECTO;
    return;
  }
  const pref = await leerPreferencias();
  $('sonidoLeads').checked = pref.sonidoLeads;
  $('sonidoIvr').checked = pref.sonidoIvr;
  await cargar();
}

$('ingreso').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('errorIngreso').textContent = '';
  const servidor = $('servidor').value.trim().replace(/\/+$/, '');
  try {
    const r = await fetch(`${servidor}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: $('nombreUsuario').value, clave: $('clave').value }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message ?? `Error ${r.status}`);
    await chrome.storage.local.set({ ultimoServidor: servidor });
    await guardarSesion({ servidor, token: d.token, nombre: d.nombre });
    $('clave').value = '';
  } catch (err) {
    $('errorIngreso').textContent = err instanceof TypeError
      ? `No se pudo conectar con el servidor (${err.message}). Revisá la dirección y que la PC tenga instalado el certificado del discador.`
      : err.message;
  }
});

$('salir').addEventListener('click', async () => {
  await api('/api/auth/salir', { metodo: 'POST' }).catch(() => {});
  await guardarSesion(null);
});

for (const id of ['sonidoLeads', 'sonidoIvr']) {
  $(id).addEventListener('change', async () => {
    const pref = await leerPreferencias();
    await chrome.storage.local.set({ preferencias: { ...pref, [id]: $(id).checked } });
  });
}

document.querySelectorAll('.pestanas button').forEach((b) =>
  b.addEventListener('click', () => {
    origen = b.dataset.origen;
    document.querySelectorAll('.pestanas button').forEach((x) => x.classList.toggle('activa', x === b));
    dibujar();
    marcarVistos();
  }),
);
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    vista = b.dataset.vista;
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('activa', x === b));
    dibujar();
  }),
);

/** Los avisos del servidor viejo (antes de los leads) no traen origen: son del IVR. */
const delOrigen = (lista, o) => lista.filter((a) => (a.origen ?? 'ivr') === o);

async function cargar() {
  try {
    datos = await api('/api/avisos/mios');
    $('error').textContent = '';
  } catch (err) {
    if (!(err instanceof SesionVencida)) $('error').textContent = err.message;
  }
  dibujar();
  marcarVistos();
}

/** Lo que la vendedora ya tiene en pantalla (en la pestaña abierta) queda como visto. */
function marcarVistos() {
  if (vista !== 'pendientes') return;
  for (const a of delOrigen(datos.pendientes, origen)) {
    if (!a.visto_en) void api(`/api/avisos/${a.id}/visto`, { metodo: 'POST' }).catch(() => {});
  }
}

function haceCuanto(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const d = new Date(iso);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function boton(texto, clase, accion) {
  const b = document.createElement('button');
  b.textContent = texto;
  if (clase) b.className = clase;
  b.addEventListener('click', accion);
  return b;
}

function etiqueta(texto, clase) {
  const s = document.createElement('span');
  s.className = `etiqueta ${clase}`;
  s.textContent = texto;
  return s;
}

function botonCopiar(texto, valor) {
  const b = boton(texto, 'chico', async () => {
    await navigator.clipboard.writeText(valor);
    b.textContent = 'Copiado ✓';
    setTimeout(() => (b.textContent = texto), 1500);
  });
  return b;
}

async function cambiarEstado(aviso, estado) {
  try {
    await api(`/api/avisos/${aviso.id}/estado`, { metodo: 'POST', cuerpo: { estado } });
    chrome.runtime.sendMessage({ tipo: 'refrescar' }).catch(() => {});
    await cargar();
  } catch (err) {
    $('error').textContent = err.message;
  }
}

function mostrarBurbuja(id, n) {
  $(id).textContent = n > 99 ? '99+' : String(n);
  $(id).hidden = n === 0;
}

function dibujar() {
  mostrarBurbuja('burbujaLeads', delOrigen(datos.pendientes, 'whatsapp').length);
  mostrarBurbuja('burbujaIvr', delOrigen(datos.pendientes, 'ivr').length);
  const lista = $('lista');
  lista.replaceChildren();
  const avisos = delOrigen(datos[vista], origen);
  if (!avisos.length) {
    const p = document.createElement('p');
    p.className = 'vacio';
    p.textContent = vista === 'recientes'
      ? 'Todavía no cerraste ninguno.'
      : origen === 'whatsapp'
        ? 'No tenés leads pendientes. Cuando un cliente le responda al bot de WhatsApp, aparece acá.'
        : 'No tenés clientes pendientes. Cuando alguien marque en el IVR, aparece acá.';
    lista.append(p);
    return;
  }
  for (const a of avisos) lista.append(tarjeta(a));
}

function tarjeta(a) {
  const esLead = (a.origen ?? 'ivr') === 'whatsapp';
  const t = $('tarjeta').content.firstElementChild.cloneNode(true);
  t.classList.toggle('whatsapp', a.contacto === 'whatsapp');
  t.classList.toggle('lead', esLead);
  t.classList.toggle('nuevo', vista === 'pendientes' && !a.visto_en);
  t.querySelector('.tipo').textContent = esLead ? '🟢 Lead del bot de WhatsApp' : `${a.contacto === 'whatsapp' ? '💬' : '📞'} ${TEXTO_CONTACTO[a.contacto]}`;
  t.querySelector('.hora').textContent = haceCuanto(a.creado_en);

  const etiquetas = t.querySelector('.etiquetas');
  const producto = productoDe(a);
  if (producto) etiquetas.append(etiqueta(TEXTO_PRODUCTO[producto], producto));
  if (a.compania) etiquetas.append(etiqueta(a.compania, 'compania'));
  if (esLead && !a.dni) etiquetas.append(etiqueta('Revisar DNI', 'revisar'));
  if (esLead && producto === 'fibra' && !a.direccion) etiquetas.append(etiqueta('Revisar dirección', 'revisar'));

  t.querySelector('.numero').textContent = formatoTelefono(a.telefono);
  t.querySelector('.nombre').textContent = a.nombre ?? '';

  // DNI (copiable) y dirección de fibra; si el DNI no se pudo leer, lo que escribió el cliente
  const detalle = t.querySelector('.detalle');
  if (a.dni) {
    const fila = document.createElement('div');
    fila.className = 'dato';
    fila.append(`DNI ${a.dni} `, botonCopiar('Copiar DNI', a.dni));
    detalle.append(fila);
  } else if (a.dni_texto) {
    const fila = document.createElement('div');
    fila.className = 'dato suave';
    fila.textContent = `Respondió: "${a.dni_texto}"`;
    detalle.append(fila);
  }
  if (a.direccion) {
    const fila = document.createElement('div');
    fila.className = 'dato direccion';
    fila.textContent = a.direccion;
    detalle.append(fila);
  }

  t.querySelector('.campana').textContent = [
    vista === 'recientes' ? (a.estado === 'contactado' ? 'Contactado' : 'Descartado') : null,
    esLead ? null : a.campana,
  ].filter(Boolean).join(' · ');

  const acciones = t.querySelector('.acciones');
  if (a.contacto === 'whatsapp') acciones.append(boton('Abrir chat', 'whatsapp', () => chrome.tabs.create({ url: enlaceWhatsapp(a.telefono) })));
  acciones.append(botonCopiar('Copiar número', a.telefono));
  if (vista === 'pendientes') {
    acciones.append(boton('Contactado', 'primario', () => cambiarEstado(a, 'contactado')));
    acciones.append(boton('Descartar', '', () => cambiarEstado(a, 'descartado')));
  } else {
    acciones.append(boton('Volver a pendientes', 'chico', () => cambiarEstado(a, 'pendiente')));
  }
  return t;
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.tipo === 'avisos') void cargar();
});
chrome.storage.onChanged.addListener((cambios, area) => {
  if (area === 'session' && 'conexion' in cambios) void mostrarConexion();
  if (area === 'local' && 'sesion' in cambios) void iniciar();
});
setInterval(() => {
  if (!$('principal').hidden) void cargar();
}, 10_000);

void mostrarConexion();
void iniciar();
