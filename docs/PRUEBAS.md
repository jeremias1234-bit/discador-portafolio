# Pruebas de telefonía sin teléfonos reales (solo desarrollo)

Para probar el motor, el IVR y el puesto del vendedor sin llamar a nadie, el Asterisk de desarrollo se llama a sí mismo: un gateway **simulador** apunta a `127.0.0.1` y el dialplan `asterisk/dev/simulador.conf` imita a los clientes según el número. **Nunca instalar esto en producción.**

## Instalación (una vez, en la PC de desarrollo)

```bash
sudo mkdir -p /etc/asterisk/dev
sudo cp asterisk/dev/simulador.conf /etc/asterisk/dev/
echo '#include dev/simulador.conf ; SOLO DESARROLLO' | sudo tee -a /etc/asterisk/extensions.conf
# En [desde-gateways], antes del _X., para que los números del simulador no se rechacen:
sudo sed -i 's/^\[desde-gateways\]$/[desde-gateways]\nexten => _999XXXXXXX,1,Goto(simulador,${EXTEN},1) ; SOLO DESARROLLO/' /etc/asterisk/extensions.conf
sudo asterisk -rx "dialplan reload"
```

Para probar el predictivo con una base de números de 10 dígitos **sin llamar a nadie** (solo vuelve por el gateway simulador):

```bash
sudo sed -i 's/^exten => _999XXXXXXX,1,Goto(simulador,${EXTEN},1) ; SOLO DESARROLLO$/&\nexten => _XXXXXXXXXX,1,GotoIf($["${CHANNEL(endpoint)}" = "simulador"]?simulador-azar,${EXTEN},1) ; SOLO DESARROLLO\n same => n,Hangup(21)/' /etc/asterisk/extensions.conf
```

La campaña de prueba tiene que tener **solo el gateway simulador** (no "todos los gateways") y los Dinstar apagados.

Desde el panel (o la API): crear el gateway `simulador` con IP `127.0.0.1` y **desactivar los Dinstar** mientras se prueba, para que ninguna llamada salga a la red celular.

## Clientes simulados

| Número | Comportamiento | Resultado esperado |
|---|---|---|
| `99900001NN` | atiende, saluda corto y se queda | llega al vendedor |
| `99900002NN` | contestador (mensaje largo) | `contestador` (AMD `MACHINE`) |
| `99900003NN` | ocupado | `ocupado` |
| `99900004NN` | suena y no atiende | `no_contesta` al vencer el timbre |
| `99900005NN` | atiende y aprieta 1 | pasa al vendedor (modos `presione_1` / `cualquiera`) |
| `99900006NN` | atiende y aprieta 3 | `no_llame_ivr` y el número entra a No Llame |
| `99900009NN` | atiende y aprieta 2 | en un IVR con aviso: `aviso_ivr`, aviso de WhatsApp para el próximo vendedor del turno |
| `99900008NN` | manda audio mientras suena (183 con audio, como el Dinstar) y no atiende | el vendedor escucha ese audio en la llamada manual |
| `99900007NN` | atiende y corta | `corto_en_mensaje` / `atendida` según la fase |
| cualquier otro de 10 dígitos | al azar: 40 % persona (10 s a 10 min), 15 % contestador, 10 % ocupado, 35 % no contesta | según el caso |

Las teclas se mandan a los ~2,5 s de atender: si la campaña tiene AMD, caen durante la detección y se pierden. Para probar teclas, usar una campaña sin AMD.

## Vendedores simulados

Abre la línea del interno `1002` como si su softphone marcara `9000`:

```bash
sudo asterisk -rx "channel originate Local/ag-1002@prueba-linea application Wait 3600"
```

Colgar ese canal equivale a que el vendedor cierre el softphone.

## Panel desde la misma PC del Asterisk

Si el panel se abre como `http://localhost:5173`, el softphone se registra desde `127.0.0.1`, la misma IP del gateway `simulador`, y Asterisk lo identifica como el gateway (el REGISTER da *404 Not Found*). En desarrollo hay que apuntar el softphone a la IP de la VPN:

```bash
VITE_SIP_WSS=wss://10.0.0.6:8089/ws npm run dev:panel
```

En la oficina no pasa: cada PC tiene su propia IP.

## Vigilante de canales

Para probarlo, crear un canal `ll-…` que no corresponda a ninguna llamada (lo tiene que colgar en menos de 15 s):

```bash
set -a; . apps/backend/.env; set +a
curl -s -u "$ARI_USUARIO:$ARI_PASSWORD" -X POST "$ARI_URL/ari/channels?endpoint=Local/9990000101@simulador&channelId=ll-999999&otherChannelId=ll-999999b&extension=9990000101&context=simulador"
```

## Línea muerta del vendedor

Si el navegador se cierra o se cuelga con la línea abierta, el cliente no puede quedar hablándole a nadie:
- **Se cierra la pestaña:** el softphone manda BYE al salir (`pagehide`).
- **El navegador muere (kill, cuelgue) con la PC viva:** se cae el WebSocket SIP, Asterisk saca el contacto, el interno pasa a `offline` y el backend corta la línea (`EndpointStateChange`). Probado con `kill -9`: se corta en menos de 1 s.
- **Se corta la luz o la red de la PC:** no llega nada; Asterisk corta por falta de audio a los 20 s (`rtp_timeout` en `pjsip.conf`). Desde la misma PC no se puede probar: el sistema operativo contesta "puerto inalcanzable" a cada paquete y Asterisk lo toma como actividad.
