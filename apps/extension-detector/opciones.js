// Opciones y estado del Detector (también es el popup del ícono).
import { guardarAjustes, leerAjustes } from './comun.js';

const $ = (id) => document.getElementById(id);

async function mostrar() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const a = await leerAjustes();
  $('servidor').value = a.servidor;
  $('token').value = a.token;
  $('pc').value = a.pc;
  $('pausado').checked = a.pausado;
  await mostrarEstado();
}

async function mostrarEstado() {
  const { lector, cola = [], conexion, registro = [], contador } = await chrome.storage.local.get(['lector', 'cola', 'conexion', 'registro', 'contador']);
  const a = await leerAjustes();
  const vivo = lector && Date.now() - lector.en < 120_000 && lector.modo === 'principal';
  const [texto, clase] = a.pausado ? ['En pausa', 'aviso']
    : !vivo ? ['No está leyendo WhatsApp', 'mal']
      : conexion?.ok === false ? ['Sin conexión con el discador', 'mal']
        : ['Andando', 'ok'];
  $('estado').textContent = texto;
  $('estado').className = `chip ${clase}`;
  const hoy = new Date().toLocaleDateString('sv-SE');
  $('detalle').textContent = [
    `Leads hoy: ${contador?.fecha === hoy ? contador.n : 0}`,
    `En cola: ${cola.length}`,
    lector?.version ? `wa-js ${lector.version}` : 'wa-js sin cargar',
    conexion?.en ? `Último contacto con el discador: ${new Date(conexion.en).toLocaleTimeString('es-AR')}${conexion.ok ? '' : ` (${conexion.error})`}` : null,
  ].filter(Boolean).join(' · ');
  $('registro').replaceChildren(...registro.map((e) => {
    const d = document.createElement('div');
    d.className = e.tipo;
    d.textContent = `${new Date(e.en).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${e.texto}`;
    return d;
  }));
  if (!registro.length) $('registro').textContent = 'Sin eventos todavía.';
}

$('guardar').addEventListener('click', async () => {
  const servidor = $('servidor').value.trim().replace(/\/+$/, '');
  if (servidor && !servidor.startsWith('https://')) {
    $('resultado').textContent = 'El servidor tiene que empezar con https://';
    return;
  }
  await guardarAjustes({ servidor, token: $('token').value.trim(), pc: $('pc').value.trim() || 'PC del bot', pausado: $('pausado').checked });
  $('resultado').textContent = 'Guardado ✓';
  chrome.runtime.sendMessage({ tipo: 'latido_ya' }).catch(() => {});
  chrome.runtime.sendMessage({ tipo: 'ajustes_cambiados' }).catch(() => {});
  setTimeout(() => void mostrarEstado(), 1500);
});

$('probar').addEventListener('click', async () => {
  $('resultado').textContent = 'Probando…';
  const r = await chrome.runtime.sendMessage({ tipo: 'probar' }).catch((err) => ({ ok: false, error: err.message }));
  $('resultado').textContent = r?.ok
    ? 'Conexión y token OK ✓ (no se creó ningún lead)'
    : `Falló: ${r?.error ?? 'sin respuesta'}. Revisá el servidor, el token y que esta PC tenga el certificado del discador.`;
  void mostrarEstado();
});

chrome.storage.onChanged.addListener((_c, area) => {
  if (area === 'local') void mostrarEstado();
});

void mostrar();
