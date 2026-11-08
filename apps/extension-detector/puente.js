// Puente entre la página de WhatsApp Web (donde corre lector.js, en el contexto de la página) y el
// fondo de la extensión. Solo pasa mensajes: no lee ni toca nada de WhatsApp.
//   página -> fondo: leads detectados y estado del lector
//   fondo -> página: textos disparadores y si el Detector está en pausa
(() => {
  const MARCA = '__detectorLeads';

  async function mandarReglas() {
    const { reglas, ajustes } = await chrome.storage.local.get(['reglas', 'ajustes']);
    window.postMessage({ [MARCA]: 'reglas', reglas: reglas ?? null, pausado: !!ajustes?.pausado }, window.location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || !(MARCA in d)) return;
    if (d[MARCA] === 'pedir_reglas') return void mandarReglas();
    if (d[MARCA] === 'lead' || d[MARCA] === 'estado' || d[MARCA] === 'sin_wpp' || d[MARCA] === 'evento') {
      chrome.runtime.sendMessage({ tipo: d[MARCA], datos: d.datos ?? null }).catch(() => {});
    }
  });

  chrome.storage.onChanged.addListener((cambios, area) => {
    if (area === 'local' && ('reglas' in cambios || 'ajustes' in cambios)) void mandarReglas();
  });

  void mandarReglas();
})();
