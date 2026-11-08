// Lector del Detector: corre en el contexto de la página de WhatsApp Web y escucha los mensajes
// nuevos de TODOS los chats (sin abrirlos) con la librería wa-js (window.WPP). Si TURBO BOT ya la
// cargó, se usa esa misma instancia; si no, el fondo de la extensión inyecta la copia empaquetada.
//
// SOLO LECTURA: acá no se usa ninguna función que mande mensajes, marque como leído, abra o cierre
// chats ni cambie nada en WhatsApp. Solo se escuchan eventos y se lee el historial reciente.
//
// Regla de disparo: el lead sale apenas el cliente responde el PRIMER menú del bot eligiendo Claro
// (1 o "claro"). Cada vez que después responde el segundo menú (portabilidad o fibra), el pedido de
// DNI o el de domicilio, se vuelve a mandar y el discador completa el mismo lead (interés, DNI,
// dirección) en lugar de crear otro. Solo cuenta lo que responde a esos pedidos del bot: un "1"
// suelto en otro momento no dispara. Otras compañías no son leads.
(() => {
  if (window.__detectorLeadsActivo) return;
  window.__detectorLeadsActivo = true;

  const MARCA = '__detectorLeads';
  const MENSAJES_HACIA_ATRAS = 30; // historial que se mira para encontrar el pedido del bot
  const VENTANA_DISPARO_MIN = 60; // el pedido del bot tiene que ser de la última hora
  const ESPERA_WPP_MS = 15_000; // si en este tiempo no aparece window.WPP, se pide inyectarla

  let reglas = null; // { disparadores_portabilidad, disparadores_fibra, horas_deduplicacion, antiguedad_max_min }
  let pausado = false;
  let suscripto = false;
  const inicio = Date.now();
  /** chatId -> { huella, en }: lo último mandado, para no repetir el mismo lead */
  const enviados = new Map();
  /** chats descartados por compañía, para anotarlos una sola vez en el registro */
  const ignorados = new Set();
  /** Por qué el último mensaje no generó ni completó un lead (para el registro) */
  let motivoSinLead = '';

  const enviar = (tipo, datos) => window.postMessage({ [MARCA]: tipo, datos }, window.location.origin);
  const evento = (texto) => enviar('evento', { texto });

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d[MARCA] !== 'reglas') return;
    if (d.reglas) reglas = d.reglas;
    pausado = !!d.pausado;
  });
  enviar('pedir_reglas');

  // --- Texto ---

  /** minúsculas, sin acentos, emojis ni signos, espacios simples */
  function normalizar(t) {
    return String(t ?? '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const contieneAlguno = (texto, lista) => {
    const n = normalizar(texto);
    return (lista ?? []).some((d) => {
      const nd = normalizar(d);
      return nd.length >= 3 && n.includes(nd);
    });
  };

  /** DNI de lo que escribió el cliente (el discador lo vuelve a validar). */
  function extraerDni(texto) {
    const t = String(texto ?? '');
    const cuit = /(?<!\d)(20|23|24|27|30|33|34)[-.\s]?(\d{1,2}[.\s]?\d{3}[.\s]?\d{3})[-.\s]?\d(?!\d)/.exec(t);
    if (cuit) {
      const dni = cuit[2].replace(/\D/g, '');
      if (dni.length >= 7) return dni;
    }
    const m = /(?<!\d)(\d{1,2}[.\s]?\d{3}[.\s]?\d{3})(?!\d)/.exec(t);
    const dni = m?.[1].replace(/\D/g, '');
    return dni && dni.length >= 7 && dni.length <= 8 ? dni : null;
  }

  const COMPANIAS = ['claro', 'personal', 'tuenti', 'movistar'];
  const NOMBRE_COMPANIA = { claro: 'Claro', personal: 'Personal', tuenti: 'Tuenti', movistar: 'Movistar' };

  // --- Mensajes (los objetos de wa-js cambian entre versiones: se leen con cuidado) ---

  const esDelBot = (m) => !!(m?.id?.fromMe ?? m?.fromMe);
  const textoDe = (m) => String(m?.body ?? m?.caption ?? '');
  const horaDe = (m) => Number(m?.t ?? 0) * 1000;
  const idDe = (m) => m?.id?._serialized ?? m?.id?.id ?? (typeof m?.id === 'string' ? m.id : null);
  const chatDe = (m) => {
    const de = m?.id?.remote ?? m?.from ?? m?.chatId;
    return typeof de === 'string' ? de : de?._serialized ?? null;
  };

  async function telefonoDe(chatId, msg) {
    if (chatId.endsWith('@c.us')) return chatId.split('@')[0];
    // Chats con LID (WhatsApp oculta el número): se pide el número asociado
    if (chatId.endsWith('@lid')) {
      try {
        const r = await window.WPP.contact.getPnLidEntry(chatId);
        const pn = r?.phoneNumber?._serialized ?? r?.phoneNumber?.id;
        if (pn) return String(pn).split('@')[0];
      } catch { /* sigue abajo */ }
      const alt = msg?.senderObj?.phoneNumber?._serialized ?? msg?.senderObj?.phoneNumber;
      if (alt) return String(alt).split('@')[0];
    }
    return null;
  }

  // Los menús del bot se reconocen por lo que contienen y no por la frase exacta, porque el texto
  // del bot cambia ("¿Qué empresa tienes?", "¿Actualmente qué compañía tienes?"…).
  /** Primer menú: el mensaje del bot que nombra al menos 3 de las 4 compañías. */
  const esMenuEmpresa = (n) => COMPANIAS.filter((c) => n.includes(c)).length >= 3;
  /** Segundo menú (1 portabilidad, 2 fibra): "el trámite/proceso que quiere/desea realizar", o mantener el número + fibra. */
  const esMenuProceso = (n) => /(tramite|proceso) que (quiere|desea|queres|deseas) realizar/.test(n) || (n.includes('manteniendo') && /fibra|fiber/.test(n));
  /** "Veo que eres cliente de Claro", "que sos Cliente Claro"… -> 'claro' */
  const companiaConfirmada = (n) => /cliente (?:de )?(claro|personal|tuenti|movistar)\b/.exec(n)?.[1] ?? null;

  /**
   * Compañía del cliente: la que confirma el bot ("…que sos Cliente Claro"), o si no la respuesta
   * al primer menú (1 Claro 2 Personal 3 Tuenti 4 Movistar): el número que marcó o el nombre que
   * escribió. null si no se puede saber.
   */
  function companiaDe(mensajes) {
    let compania = null;
    for (let i = 0; i < mensajes.length; i++) {
      const m = mensajes[i];
      const n = normalizar(textoDe(m));
      if (!esDelBot(m)) continue;
      const confirmada = companiaConfirmada(n);
      if (confirmada && !esMenuEmpresa(n)) {
        compania = NOMBRE_COMPANIA[confirmada];
        continue;
      }
      if (esMenuEmpresa(n)) {
        // Opciones en el orden en que el bot las lista, por su última aparición: el saludo
        // ("bienvenido a Movistar") también nombra una compañía, antes de las opciones.
        const opciones = COMPANIAS.filter((c) => n.includes(c)).sort((a, b) => n.lastIndexOf(a) - n.lastIndexOf(b));
        const respuesta = mensajes.slice(i + 1).find((x) => !esDelBot(x));
        const r = normalizar(textoDe(respuesta));
        const numero = /^(\d)\b/.exec(r)?.[1];
        const porNumero = numero ? opciones[Number(numero) - 1] : null;
        const porNombre = COMPANIAS.find((c) => r.includes(c));
        const elegida = porNumero ?? porNombre;
        if (elegida) compania = NOMBRE_COMPANIA[elegida];
      }
    }
    return compania;
  }

  /** Qué le pidió el bot en este mensaje: empresa, proceso, dni, domicilio u otro (null si no es un texto del bot). */
  function pedidoDe(m) {
    if (!esDelBot(m) || (m?.type && m.type !== 'chat')) return null;
    const t = textoDe(m);
    if (!t.trim()) return null;
    const n = normalizar(t);
    if (esMenuEmpresa(n)) return 'empresa';
    if (contieneAlguno(t, reglas.disparadores_fibra)) return 'domicilio';
    if (contieneAlguno(t, reglas.disparadores_portabilidad)) return 'dni';
    if (esMenuProceso(n)) return 'proceso';
    return 'otro';
  }

  /**
   * Datos del lead a partir del historial del chat; null si no corresponde mandar nada.
   * El lead sale apenas el cliente responde el PRIMER menú eligiendo Claro, y se vuelve a mandar
   * (el discador completa el mismo lead) cuando responde el segundo menú (portabilidad o fibra), el
   * pedido de DNI o el de domicilio. Un mensaje del cliente que no responde a ninguno de esos
   * pedidos (un "1" o un "claro" sueltos en otro momento) no dispara nada.
   */
  function armarLead(historial, entrante) {
    const hora = horaDe(entrante);
    // El historial ya llega cortado en este mensaje y en el orden del chat (alMensaje)
    const anteriores = historial;
    // Último texto del bot antes de este mensaje del cliente: es lo que el cliente está respondiendo
    let ultimo = null;
    for (let i = anteriores.length - 1; i >= 0; i--) {
      const p = pedidoDe(anteriores[i]);
      if (p) { ultimo = { pedido: p, m: anteriores[i] }; break; }
    }
    if (!ultimo || ultimo.pedido === 'otro') {
      motivoSinLead = ultimo ? `lo último del bot: «${textoDe(ultimo.m).replace(/\s+/g, ' ').slice(0, 45)}…»` : 'no hay mensajes del bot antes';
      return null;
    }
    if (hora - horaDe(ultimo.m) > VENTANA_DISPARO_MIN * 60_000) {
      motivoSinLead = 'el pedido del bot es de hace más de una hora';
      return null;
    }

    // Pedidos del bot en la conversación (el último de cada tipo)
    let iDomicilio = -1;
    let iDni = -1;
    let iProceso = -1;
    for (let i = 0; i < anteriores.length; i++) {
      const p = pedidoDe(anteriores[i]);
      if (p === 'domicilio') iDomicilio = i;
      else if (p === 'dni') iDni = i;
      else if (p === 'proceso') iProceso = i;
    }
    /** Lo que respondió el cliente después del mensaje i del bot, hasta el próximo mensaje de texto del bot */
    const respuestaA = (i) => {
      if (i < 0) return null;
      const partes = [];
      for (const m of anteriores.slice(i + 1)) {
        if (esDelBot(m)) {
          // Una imagen del bot ("un asesor se va a comunicar"), aunque tenga texto, no corta: el
          // cliente puede mandar el DNI después. Otro mensaje de texto del bot sí.
          if (m?.type && m.type !== 'chat') continue;
          if (textoDe(m).trim()) break;
          continue;
        }
        const t = textoDe(m).trim();
        if (t) partes.push(t);
      }
      return partes.length ? partes.join('\n').slice(0, 1000) : null;
    };

    const compania = companiaDe(anteriores);

    // Interés: lo que eligió en el segundo menú (1 portabilidad, 2 fibra); si pidió domicilio es
    // fibra y si solo pidió DNI, portabilidad. Antes del segundo menú todavía no se sabe.
    const proceso = normalizar(respuestaA(iProceso) ?? '');
    let interes = null;
    if (/^2\b/.test(proceso) || /fibra|fiber/.test(proceso)) interes = 'fibra';
    else if (/^1\b/.test(proceso) || /portab|numero|mantener/.test(proceso)) interes = 'portabilidad';
    if (iDomicilio >= 0) interes = 'fibra';
    else if (!interes && iDni >= 0) interes = 'portabilidad';

    const dniTexto = respuestaA(iDni);
    const direccion = respuestaA(iDomicilio);
    return {
      interes,
      compania,
      dni: extraerDni(dniTexto),
      dni_texto: dniTexto,
      direccion,
    };
  }

  async function alMensaje(msg) {
    try {
      if (!reglas || pausado || esDelBot(msg)) return;
      const chatId = chatDe(msg);
      if (!chatId || chatId.endsWith('@g.us') || chatId.includes('broadcast') || chatId.endsWith('@newsletter')) return;
      // Mensajes viejos (al abrir WhatsApp Web se cargan chats anteriores): no disparan
      const hora = horaDe(msg);
      const limite = reglas.antiguedad_max_min * 60_000;
      if (!hora || Date.now() - hora > limite || hora < inicio - limite) return;

      const historial = await window.WPP.chat.getMessages(chatId, { count: MENSAJES_HACIA_ATRAS });
      // El historial viene en el orden del chat. Se corta en el mensaje que acaba de llegar: lo que
      // el bot contestó después (muchas veces en el mismo segundo, y la hora de WhatsApp es por
      // segundo) no tiene que confundirse con lo que el cliente está respondiendo.
      let lista = Array.isArray(historial) ? historial.slice() : [];
      if (lista.length > 1 && horaDe(lista[0]) > horaDe(lista[lista.length - 1])) lista.reverse(); // por si viene del más nuevo al más viejo
      const posicion = lista.findIndex((m) => idDe(m) === idDe(msg));
      if (posicion >= 0) lista = lista.slice(0, posicion + 1);
      else lista = [...lista.filter((m) => horaDe(m) < hora), msg];
      motivoSinLead = '';
      const lead = armarLead(lista, msg);
      if (!lead) {
        // Diagnóstico: si el chat ya tiene lead y llega un mensaje que no lo completa, se anota por qué
        if (enviados.has(chatId)) {
          evento(`••${chatId.split('@')[0].slice(-4)}: no responde a un pedido del bot (${motivoSinLead || 'sin motivo'}; historial ${lista.length} mensajes, ${posicion >= 0 ? 'con' : 'sin'} el mensaje nuevo)`);
        }
        return;
      }
      // Solo las compañías a las que se vende (hoy, Claro): las demás no son leads
      const permitidas = (reglas.companias ?? []).map(normalizar);
      if (permitidas.length && !permitidas.includes(normalizar(lead.compania))) {
        const clave = `${chatDe(msg)}|${lead.compania ?? '?'}`;
        if (!ignorados.has(clave)) {
          ignorados.add(clave);
          evento(lead.compania ? `No es lead: cliente de ${lead.compania}` : 'No es lead: no se pudo saber la compañía del cliente (revisar a mano)');
        }
        return;
      }

      // El mismo lead con los mismos datos no se repite; si llegó un dato nuevo, se manda para completar
      const huella = JSON.stringify(lead);
      const previo = enviados.get(chatId);
      const ventana = reglas.horas_deduplicacion * 3_600_000;
      if (previo && previo.huella === huella && Date.now() - previo.en < ventana) return;

      const telefono = await telefonoDe(chatId, msg);
      if (!telefono) {
        evento('No se pudo obtener el número de un chat (WhatsApp lo oculta): revisalo a mano');
        return;
      }
      enviados.set(chatId, { huella, en: Date.now() });
      enviar('lead', {
        telefono,
        nombre: msg?.notifyName || msg?.senderObj?.pushname || msg?.senderObj?.name || null,
        ...lead,
        chat_hora: new Date(hora).toISOString(),
      });
    } catch (err) {
      evento(`Error leyendo un mensaje: ${err?.message ?? err}`);
    }
  }

  // Limpieza de lo ya enviado (una vez por hora)
  setInterval(() => {
    const ventana = (reglas?.horas_deduplicacion ?? 24) * 3_600_000;
    for (const [k, v] of enviados) if (Date.now() - v.en > ventana) enviados.delete(k);
  }, 3_600_000);

  // --- Conexión con wa-js ---

  function suscribir() {
    if (suscripto || !window.WPP?.isReady) return;
    window.WPP.on('chat.new_message', (msg) => void alMensaje(msg));
    suscripto = true;
    evento(`Leyendo WhatsApp (wa-js ${window.WPP.version ?? '?'})`);
  }

  function estado() {
    const listo = !!window.WPP?.isReady && suscripto;
    enviar('estado', { modo: listo ? 'principal' : 'caido', version: window.WPP?.version ?? null, en: Date.now() });
  }

  let pedida = false;
  setInterval(() => {
    if (!window.WPP && !pedida && Date.now() - inicio > ESPERA_WPP_MS) {
      pedida = true;
      enviar('sin_wpp'); // el fondo inyecta la copia empaquetada de wa-js
    }
    suscribir();
  }, 2000);
  setInterval(estado, 30_000);
  setTimeout(estado, 5000);
})();
