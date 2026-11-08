# Arquitectura

```
                                         ┌─────────────┐
                                         │    Redis    │  estado en vivo
                                         └──────▲──────┘
                                                │
 dinstar_10..13 ──SIP──► Asterisk ──ARI──►     BACKEND      ◄──REST/WS──► FRONTEND
 (Dinstar GSM)           │  ▲                  │                       agente / supervisor / admin
                         │  └──── WSS (WebRTC) ┼───────────────────────  softphone del agente
                         │                     ▼
                         │              ┌─────────────┐
                         │              │ PostgreSQL  │  datos persistentes
                         │              └─────────────┘
                         └──► grabaciones (disco del servidor)
```

## Componentes

| Componente | Responsabilidad |
|---|---|
| **Gateways Dinstar** | Salida a la red celular. Se registran contra Asterisk por SIP. |
| **Asterisk** | Solo telefonía: originar, AMD, puentear audio, grabar. **No decide nada**: el dialplan entrega todo a la app ARI `discador`. |
| **Backend** | Toda la lógica, en un solo servicio dividido en módulos: |
| ↳ `ari/` | Cliente ARI propio (REST + WebSocket con reconexión). |
| ↳ `telefonia/motor.ts` | Cada ciclo decide cuántas llamadas lanzar por campaña (progresivo, predictivo adaptativo, IVR), toma leads y respeta horario, topes y reserva para manual. |
| ↳ `telefonia/conmutador.ts` | Líneas de los vendedores, ciclo de vida de cada llamada (AMD, audio, teclas, cola, vendedor, grabación), supervisión. Estado en vivo en memoria. |
| ↳ `telefonia/asterisk.ts` | Genera `pjsip_discador.conf` desde la base (gateways e internos) y recarga PJSIP por ARI. |
| ↳ `api/` | REST + WebSocket (`/api/ws`) para el frontend, autenticación y permisos. |
| **PostgreSQL** | Datos que deben sobrevivir a un reinicio: usuarios, campañas, leads, llamadas, tipificaciones. |
| **Redis** | Sesiones del panel, freno de fuerza bruta y eventos internos (pub/sub `eventos`) para aplicar cambios en caliente. |
| **Frontend** | Consola del agente (softphone JsSIP + ficha), panel del supervisor, administración. |

## Decisiones

### 1. Toda la lógica en el backend, Asterisk "tonto"
El dialplan solo hace `Stasis(discador, ...)`. Así la lógica está en un lenguaje real, versionada, testeable, y Asterisk se puede reemplazar o escalar sin reescribir reglas de negocio.

### 2. Monolito modular, no microservicios
Para 10-20 agentes por turno, un solo servicio es más simple de operar y depurar. Los módulos están separados para poder dividirlos si algún día hiciera falta.

### 3. TypeScript de punta a punta
Un solo lenguaje para backend y frontend. Tipos compartidos entre ambos.

### 4. Agente siempre conectado
Al iniciar sesión, el softphone del agente queda en una llamada permanente con Asterisk, dentro de un bridge propio, en silencio. Cuando el motor detecta que contestó una persona, mete al cliente en ese bridge: la conexión es **instantánea**, sin que suene el teléfono del agente. Evita los segundos de silencio que hacen cortar al cliente en un predictivo.

### 5. AMD vía dialplan
`AMD()` no existe en ARI. Cuando el cliente contesta, el backend manda el canal al contexto `[amd]` (`continuarEnDialplan`), que corre AMD y devuelve el canal a Stasis con `HUMAN`/`MACHINE`/`NOTSURE`.

### 6. Predictivo conservador
Con 10-20 agentes la varianza es alta. El algoritmo arranca prudente y ajusta el ritmo según la tasa de abandono real contra el abandono objetivo (`campanas.abandono_objetivo_pct`, o el global `ritmo.abandono_objetivo_pct` de `configuracion`).

### 7. Asterisk configurado desde la base
`pjsip.conf` del repo solo tiene transportes y plantillas. El backend genera `/etc/asterisk/pjsip_discador.conf` con los gateways activos (trunk por IP) y los internos de los usuarios activos, y recarga `res_pjsip` por ARI cada vez que cambia algo en el panel. Los parámetros de AMD también salen del panel: el backend se los pasa a `AMD()` en cada llamada.

### 7 bis. Gateways en la base de datos
`gateways` guarda `canales`, `canales_reservados_manual` y `orden` de cada Dinstar; cada campaña limita qué gateways usa y su `tope_canales`. El motor elige por cuál salir (y cuenta canales en uso en Redis), en vez de fijarlo en el dialplan. Los canales reservados solo los puede ocupar una llamada manual.

### 8. Solo red local
Servidor, gateways y agentes están en la LAN de la oficina. No se expone nada a internet y no hace falta VPN. Las llamadas salen por GSM, así que **un corte de internet no frena la operación**. Si algún día hay agentes remotos, se agrega una VPN sin cambiar la arquitectura.

### 9. IVR saliente integrado al predictivo
Cuando el cliente atiende escucha un mensaje pregrabado de la campaña ("...espera en línea y un asesor te atenderá") y, tras unos segundos de espera, pasa al vendedor libre. El mensaje da tiempo a que un vendedor se libere, así que el predictivo puede marcar más rápido sin subir el abandono. Configurable por campaña:
- **Permanencia + AMD:** pasa quien sigue en línea; el AMD filtra los contestadores, que también "se quedan".
- **Presione 1:** pasa solo quien marca 1. Filtro casi perfecto de contestadores e interesados.

Los audios se suben desde el admin y se guardan en `/var/lib/asterisk/sounds/campanas/`.

### 10. Cliente ARI propio
Las librerías ARI de Node están poco mantenidas. ARI es REST + WebSocket: un cliente propio son ~150 líneas que controlamos.

## Flujos

### Llamada predictiva / progresiva (con IVR)
```
motor elige lead (no está en No Llame, dentro de horario)
 └► originar PJSIP/<numero>@dinstar_NN   (registro en llamadas)
     ├─ no contesta / ocupado / falla ─► resultado + programar reintento
     └─ contesta ─► AMD (si la campaña lo tiene activo)
          ├─ MACHINE ─► colgar, resultado 'contestador'
          └─ HUMAN ─► IVR (si la campaña lo tiene activo): mensaje + espera
               ├─ cortó durante el mensaje ─► 'corto_en_mensaje'
               ├─ modo presione 1 y no marcó ─► 'sin_confirmar'
               └─ sigue en línea / marcó 1 ─► ¿agente libre?
                    ├─ sí ─► al bridge del agente + grabar + ficha en pantalla
                    └─ no ─► música de espera hasta espera_max_seg
                         ├─ se libera un agente ─► al bridge del agente
                         └─ vence ─► 'abandonada' (cuenta para la tasa de abandono)
```

### Línea siempre abierta
```
softphone marca 9000 ─► [agentes] ─► Stasis(discador,linea,<interno>)
 └► backend atiende, crea el bridge del vendedor y lo deja ahí en silencio (estado: disponible)
```

### Llamada manual
```
vendedor pide llamar desde el puesto (POST /api/puesto/llamar)
 └► backend valida (permiso, horario global, No Llame) ─► origina por un gateway (puede usar la reserva)
     └► contesta ─► al bridge del vendedor + grabar
```
Un softphone **sin** línea abierta que marca un número abre una línea temporal y hace lo mismo.

## Estado en vivo

Vive en memoria del conmutador (hay un solo proceso): puestos conectados y su estado, llamadas en curso y su fase, canales en uso por gateway, estadísticas recientes por campaña para el ritmo y el abandono. Se publica por WebSocket (`/api/ws`): cada usuario recibe los eventos de su puesto y quien tiene `monitor.ver` una instantánea por segundo. La base guarda cada fase de cada llamada para los reportes.

Si el proceso se reinicia: las llamadas abiertas se cierran como `fallida`, los leads `en_curso` vuelven a `reintentar` y se cuelgan los canales huérfanos; los softphones vuelven a abrir su línea.

| Redis | Uso |
|---|---|
| `sesion:{token}` | sesiones del panel |
| `login_fallos:{usuario}` | freno de fuerza bruta |
| pub/sub `eventos` | cambios del panel ─► motor, conmutador y Asterisk (config, campañas, usuarios, gateways) |

## Contextos de Asterisk

| Contexto | Uso |
|---|---|
| `[agentes]` | `9000` = línea siempre abierta; cualquier otro número = llamada manual ─► Stasis |
| `[desde-gateways]` | Entrantes: por ahora se rechazan (IVR entrante: futuro) |
| `[amd]` | Detección de contestador, vuelve a Stasis con el resultado |
