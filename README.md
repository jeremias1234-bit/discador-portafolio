# Discador

**Discador saliente para call centers: IVR con aviso al vendedor, predictivo, llamada manual y leads de WhatsApp en tiempo real.** Corre sobre Asterisk con gateways GSM y se maneja entero desde un panel web.

Diseñado, desarrollado y puesto en producción por **Jeremias Scro**. En su primera semana de uso real hizo más de 100.000 llamadas con el IVR y repartió en tiempo real los clientes interesados entre los vendedores.

![Ícono](apps/frontend/public/logo.png)

## Qué hace

| Módulo | Qué resuelve |
|---|---|
| **IVR con aviso** | Llama a una base, detecta contestadores (AMD), pasa un mensaje grabado y el cliente marca 1 o 2 (WhatsApp o llamada). El número le llega al instante al vendedor del turno, con notificación y sonido. |
| **Audios A/B** | Dos mensajes en la misma campaña con reparto por porcentaje (por ejemplo 30/70) y comparación de resultados: cuántos escuchan, cortan o marcan con cada uno. |
| **Predictivo y progresivo** | El motor calcula cuántas llamadas lanzar según contestación, duración y abandono. Tope de llamadas por minuto repartido parejo entre campañas para cuidar los chips. |
| **Leads del bot de WhatsApp** | Una extensión de Chrome lee WhatsApp Web en solo lectura. Cuando el cliente elige su compañía en el menú del bot, el lead sale en segundos y se completa solo con el producto, el DNI y la dirección. |
| **Reparto por reglas** | Turnos rotativos por día y horario: en horario de trabajo solo a los vendedores conectados; fuera de horario, a quienes se elija, aunque estén desconectados. |
| **Puesto del vendedor** | Softphone WebRTC en el navegador con línea siempre abierta, ficha del cliente, tipificación y llamada manual. |
| **Supervisión** | Monitor en vivo (vendedores, gateways, llamadas, motor), escuchar, susurrar e intervenir, grabaciones y reportes con exportación. |
| **Administración** | Usuarios con permisos individuales, campañas, bases CSV con millones de filas, audios, gateways, horarios y feriados, registro No Llame, bitácora de cambios. |

## Arquitectura

```
                                         ┌─────────────┐
                                         │    Redis    │  estado en vivo
                                         └──────▲──────┘
                                                │
 Gateways GSM ──SIP──► Asterisk ──ARI──►     BACKEND      ◄──REST/WS──► PANEL WEB
 (Dinstar)             │  ▲                  │                        vendedor / supervisor / admin
                       │  └──── WSS (WebRTC) ┼────────────────────────  softphone del vendedor
                       │                     ▼
                       │              ┌─────────────┐
                       │              │ PostgreSQL  │  llamadas, bases, avisos, leads
                       │              └─────────────┘        ▲
                       └──► grabaciones                       │
                                                              │ HTTPS (token de servicio)
 WhatsApp Web + bot ──► Extensión "Detector" (solo lectura) ──┘
 Vendedores ◄── Extensión de Chrome (pestañas LEADS | IVR, long polling)
```

- **Toda la lógica está en el backend.** Asterisk solo conecta audio: el backend lo maneja por ARI (cliente propio) y genera su configuración desde la base.
- **Monolito modular en TypeScript de punta a punta**: backend, panel y extensiones.
- **Tiempo real:** WebSocket para el panel y long polling para las extensiones. Chrome no permite que una extensión abra un WebSocket a una IP de la red local.
- **Solo red local:** nada queda expuesto a internet. HTTPS con una CA propia que cada PC instala una vez.

Más detalle en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Stack

| Capa | Tecnología |
|---|---|
| Telefonía | Asterisk 22 (PJSIP + ARI), gateways Dinstar GSM, AMD |
| Backend | Node.js 24, TypeScript, Fastify, Zod |
| Datos | PostgreSQL 17 (migraciones SQL numeradas), Redis |
| Panel | React, TypeScript, Vite, JsSIP (softphone WebRTC) |
| Extensiones | Chrome Manifest V3: avisos para vendedores y Detector de leads ([wa-js](https://github.com/wppconnect-team/wa-js)) |
| Despliegue | Docker Compose en Linux o en WSL2 con red "mirrored" |

## Estructura

```
apps/backend/             API, motor de marcación, conmutador de llamadas, cliente ARI, avisos y leads
apps/frontend/            panel web: puesto del vendedor, supervisor, IVR, leads y administración
apps/extension-chrome/    extensión de los vendedores (avisos del IVR y leads)
apps/extension-detector/  Detector de leads para WhatsApp Web
asterisk/                 configuración de Asterisk
db/migrations/            esquema de la base, un .sql por cambio
docker/                   imágenes de producción (Asterisk, backend, panel)
docs/                     arquitectura, instalación, comandos y pruebas
```

## Puesta en marcha (desarrollo)

```bash
docker compose up -d                       # PostgreSQL + Redis
npm install
cp apps/backend/.env.example apps/backend/.env   # y completar las claves
npm run migrar                             # crea las tablas
npm run crear-admin -- --usuario admin --nombre "Administrador"   # primer usuario (pide la clave)
npm run dev                                # backend en http://localhost:3000
npm run dev:panel                          # panel en http://localhost:5173
npm run typecheck                          # verificación de tipos de todo el proyecto
```

Producción con Docker: [docs/INSTALACION-WSL.md](docs/INSTALACION-WSL.md) · Servidor Linux: [docs/INSTALACION.md](docs/INSTALACION.md) · Operación diaria: [docs/COMANDOS.md](docs/COMANDOS.md) · Pruebas sin teléfonos reales: [docs/PRUEBAS.md](docs/PRUEBAS.md)

## Autor

**Jeremias Scro** · [github.com/jeremias1234-bit](https://github.com/jeremias1234-bit)

© 2026 Jeremias Scro. Todos los derechos reservados. Ver [LICENSE](LICENSE).
