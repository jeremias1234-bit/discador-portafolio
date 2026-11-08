# Detector de leads (bot de WhatsApp → discador)

Extensión de Chrome para la PC donde está abierto **WhatsApp Web con TURBO BOT**. Mira los chats
**en solo lectura** y, cuando un cliente responde el pedido de DNI (portabilidad) o el de domicilio
(fibra), manda el lead al discador. El discador se lo asigna por turno a un vendedor con
"Recibe leads", que lo ve al instante en la pestaña **LEADS** de su extensión.

## Instalación

1. En el panel: **Leads → Configuración del Detector → Crear token**. Copiá el token (se muestra una sola vez).
2. Bajá la extensión desde el panel (`/api/detector.zip`, botón en la sección Leads) y descomprimila:
   queda la carpeta `discador-detector`.
3. En Chrome: `chrome://extensions` → **Modo de desarrollador** → **Cargar descomprimida** → elegí la carpeta.
4. Tocá el ícono del Detector: pegá el **token**, revisá el **servidor** y poné un **nombre para esta PC**. Guardar.
5. **Probar envío**: tiene que decir "Conexión y token OK" (no crea ningún lead).
6. Recargá la pestaña de WhatsApp Web. En unos segundos el estado pasa a **Andando** y en el panel,
   sección Leads, aparece el Detector con ✅.

La PC tiene que tener instalado el certificado del discador (el mismo que para entrar al panel).

## Cómo decide

- **El lead sale apenas el cliente elige Claro** en el primer menú ("¿Qué empresa tienes actualmente?"
  → 1 o "claro"). Le llega a la vendedora en el momento, todavía sin interés ni DNI.
- **Después se completa solo**, en el mismo lead, cada vez que el cliente responde:
  el segundo menú (1 = portabilidad, 2 = fibra), el pedido de DNI ("…número de DNI del titular…")
  o el de domicilio ("…donde desea(s) instalar el servicio…", que además lo marca como fibra).
  Si la respuesta al DNI no trae uno reconocible, queda lo que escribió y "revisar DNI".
- Solo cuenta lo que responde a esos pedidos del bot: un "1" o un "claro" sueltos en otro momento no disparan.
- **Solo Claro:** la compañía se reconoce por lo que el cliente eligió en el primer menú del bot (1 = Claro…) o por el mensaje "Veo que eres cliente de Claro". Solo las compañías de la lista del panel (hoy, Claro) generan lead; si no se puede saber la compañía, tampoco se manda (queda en el registro).
- **Un lead por número** dentro de la ventana configurada (24 h): los mensajes siguientes completan los
  datos que faltaban (DNI, dirección) en lugar de crear otro.
- **Mensajes viejos** (al abrir WhatsApp Web) no disparan: solo los de los últimos minutos configurados.
- Los textos disparadores se editan desde el panel (Leads → Configuración del Detector); el Detector
  los toma en menos de un minuto.

## Qué guarda y qué no

- No guarda conversaciones. En la extensión queda: la cola de envíos pendientes, los ajustes y un
  registro de los últimos 100 eventos con el número enmascarado (••••1234).
- Solo se comunica con el servidor del discador configurado.
- Si el discador no responde, los leads quedan en cola y se reintentan solos (30 s, 1 min, 2 min… hasta 10 min).

## Limitaciones (importante)

- Usa **wa-js** (`@wppconnect/wa-js` 4.7.2, empaquetada en `vendor/`, licencia Apache 2.0), que se
  apoya en funciones **internas, no oficiales** de WhatsApp Web. Cuando WhatsApp actualiza su web
  puede dejar de andar hasta actualizar la librería: el ícono se pone rojo ("Detector caído") y el
  panel muestra "Sin señal". Para actualizar: reemplazar `vendor/wppconnect-wa.js` por una versión nueva.
- Si TURBO BOT ya cargó wa-js en la página, el Detector usa esa misma instancia (no carga otra).
- WhatsApp no permite clientes automatizados no oficiales: TURBO BOT ya corre ese riesgo; el Detector,
  al solo leer, no suma acciones sobre la cuenta.
- WhatsApp Web tiene que estar **abierto** en esta PC: si se cierra Chrome o se apaga la PC no entran leads.
- Si WhatsApp oculta el número de un chat (identificadores "LID") y no se puede obtener, el lead no sale
  y queda anotado en el registro para revisarlo a mano.
