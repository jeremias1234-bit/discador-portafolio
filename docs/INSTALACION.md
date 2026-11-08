# Instalación del servidor (semana 1)

**Objetivo de la semana:** desde un softphone WebRTC en el navegador, hacer una llamada real a un celular saliendo por un gateway Dinstar.

## 0. Antes de empezar

- **Disco:** instalar Ubuntu en un disco dedicado. Si la PC tiene otro disco con Windows, **desconectarlo físicamente durante la instalación** y después elegir el sistema desde el menú de arranque de la BIOS (F11/F12/F8).
- **Gateway para pruebas:** los Dinstar están en la oficina. Para desarrollar fuera de ella hay dos opciones:
  1. Llevar **un** gateway (o uno con algunas SIMs) al lugar de desarrollo. Es lo más simple; coordinar con la oficina porque esas líneas salen de producción.
  2. VPN entre el lugar de desarrollo y la oficina. **Es lo que se usa hoy** (ver "Desarrollo por VPN" en la sección 4).
- **Datos:** para pruebas usar números propios, **nunca listas reales de clientes** fuera de la oficina.

## 1. Ubuntu LTS

En producción, Ubuntu Server (sin entorno gráfico) con OpenSSH habilitado. Para desarrollo sirve Ubuntu Desktop: los pasos son los mismos. Probado en **Ubuntu 26.04** (GCC 15); también sirve 24.04. Luego:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential git wget curl ufw sox libsystemd-dev
sudo timedatectl set-timezone America/Argentina/Buenos_Aires   # ajustar a la zona real
```

Conviene asignarle **IP fija** en la red local (en el router o en netplan).

## 2. Asterisk 22 LTS (compilado)

Probado con **22.11.0**. Las primeras 22.x no compilan con GCC 15; usar siempre `asterisk-22-current`.

```bash
cd /usr/src
sudo wget https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.tar.gz
sudo wget https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.sha256
sha256sum asterisk-22-current.tar.gz; cat asterisk-22-current.sha256   # deben coincidir
sudo tar xzf asterisk-22-current.tar.gz
cd asterisk-22.*/
sudo contrib/scripts/install_prereq install
sudo ./configure --with-pjproject-bundled --with-jansson-bundled
grep "define HAVE_SYSTEMD" include/asterisk/autoconfig.h   # si no aparece, falta libsystemd-dev
sudo make menuselect     # con los valores por defecto ya vienen res_pjsip, res_ari, app_amd, res_http_websocket, res_srtp
sudo make -j"$(nproc)"
sudo make install
sudo make samples        # configuración por defecto; después pisamos con la nuestra
sudo make install-logrotate
```

Servicio systemd nativo, con su propio usuario (no root). No usar `make config`: instala un script viejo de `/etc/init.d`.

```bash
sudo groupadd --system asterisk
sudo useradd --system -d /var/lib/asterisk -g asterisk -s /usr/sbin/nologin asterisk
sudo chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /usr/lib/asterisk
sudo cp contrib/systemd/asterisk.service /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/asterisk.service.d
printf '[Service]\nRuntimeDirectory=asterisk\nRuntimeDirectoryMode=0755\n' | sudo tee /etc/systemd/system/asterisk.service.d/discador.conf
sudo systemctl daemon-reload
```

## 3. Configuración del repo

```bash
git clone <repo> ~/discador
sudo cp ~/discador/asterisk/*.conf /etc/asterisk/
```

Reemplazar el `CAMBIAR_*` de `/etc/asterisk/ari.conf` por una clave fuerte (la misma va en `ARI_PASSWORD` del `.env`). Las claves **no** se suben al repo.

Gateways e internos los genera el backend desde la base en `/etc/asterisk/pjsip_discador.conf` (incluido desde `pjsip.conf`). El archivo tiene que existir y ser escribible por el usuario del backend; los audios de campañas van a un directorio que escribe el backend y lee Asterisk:

```bash
sudo install -o $USER -g asterisk -m 640 /dev/null /etc/asterisk/pjsip_discador.conf
sudo install -d -o $USER -g asterisk -m 2755 /var/lib/asterisk/sounds/campanas
sudo apt install -y libsox-fmt-mp3      # para subir audios en MP3
```

En producción, `$USER` es el usuario con el que corre el backend.

### Certificado TLS con CA propia (WebRTC exige conexión segura)

El micrófono del navegador y el WSS de Asterisk exigen HTTPS. Todo queda en la LAN, sin dominio público, así que se usa una **autoridad certificadora (CA) propia**:

```bash
sudo scripts/tls/crear-certificados.sh            # CA (una sola vez) + certificado del servidor con sus IPs
# o con IPs/nombres explícitos: sudo scripts/tls/crear-certificados.sh 192.168.1.20 discador
```

- La CA queda en `/etc/discador/ca` (la clave nunca sale de la máquina ni va al repo). Si cambian las IPs se vuelve a correr: la CA se conserva y las PCs no tienen que reinstalar nada.
- El certificado del servidor queda en `/etc/discador/tls` (dueño el usuario del backend, grupo `asterisk`). Lo usan Asterisk (`asterisk/http.conf`, WSS en el 8089) y el panel (HTTPS en el 5173).

En **cada PC de la oficina**, una sola vez (agrega la CA al sistema, a Firefox y a Chrome):

```bash
curl -fsSk https://IP_DEL_SERVIDOR:5173/api/instalar-ca.sh | sudo bash
```

Después de reiniciar el navegador, `https://IP_DEL_SERVIDOR:5173` abre sin advertencias. La huella SHA-256 que imprime el script tiene que coincidir con la que mostró `crear-certificados.sh`.

```bash
sudo systemctl enable --now asterisk
sudo asterisk -rvvv          # consola; probar: pjsip show endpoints / ari show apps

Los `declined to load` de módulos `cdr_*` / `cel_*` al arrancar son de la configuración de ejemplo y no afectan.
```

## 4. Firewall

El discador funciona **solo dentro de la red local**: todo se abre únicamente para la LAN y nada queda expuesto a internet.

```bash
LAN=192.168.1.0/24                      # ajustar a la red real de la oficina
sudo ufw default deny incoming
sudo ufw allow from $LAN to any port 22 proto tcp           # SSH
sudo ufw allow from $LAN to any port 5060 proto udp         # SIP de los Dinstar
sudo ufw allow from $LAN to any port 8089 proto tcp         # WSS de los softphones
sudo ufw allow from $LAN to any port 10000:20000 proto udp  # audio RTP
sudo ufw allow from $LAN to any port 3000 proto tcp         # API / frontend
sudo ufw enable
```

**Desarrollo por VPN:** si el Dinstar llega a la PC de desarrollo a través de la VPN, repetir las reglas de SIP y RTP con la subred de la VPN (o la IP del Dinstar tal como la ve la PC) en lugar de `$LAN`. Verificar antes con `ping` en los dos sentidos: desde la PC al Dinstar y, desde la web del Dinstar (herramienta de diagnóstico/ping), a la PC.

## 5. Configurar el Dinstar

En la web del gateway (los nombres de menú varían según el modelo):

Los Dinstar trabajan con **SIP Trunk por IP, sin registro**: el gateway acepta llamadas de la IP del trunk y Asterisk lo reconoce por su IP (`identify` en `pjsip.conf`).

| Pantalla | Valor |
|---|---|
| Red | IP fija en la LAN, gateway el router. Desactivar cualquier otra VPN del equipo |
| SIP Trunk | IP del servidor Asterisk, puerto 5060, **KeepAlive Enable = Yes** |
| SIP Trunk Group | incluir el trunk del servidor |
| Routing → IP→Tel | regla con origen ese Trunk Group y destino el Port Group de los puertos GSM |
| Códec | G.711A (alaw) primero |
| DTMF | RFC2833 |

El gateway se da de alta desde el panel (nombre, endpoint, IP, canales): el backend genera su endpoint con `contact=sip:IP:5060` e `identify` por IP en `pjsip_discador.conf`.

Verificar en Asterisk: `pjsip show contacts` debe mostrar `dinstar_10` como **Avail** con su RTT. El keepalive del Dinstar llega como `OPTIONS sip:heartbeat@servidor`; la extensión `heartbeat` de `[desde-gateways]` hace que Asterisk responda 200 en lugar de 404.

El Dinstar contesta `183 Session Progress` con audio apenas recibe el INVITE, antes de que suene el celular: el estado "sonando" no se puede tomar de la señalización SIP.


## 6. PostgreSQL + Redis + backend

```bash
# Docker
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER      # cerrar sesión y volver a entrar

# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

cd ~/discador
docker compose up -d
npm install
cp apps/backend/.env.example apps/backend/.env   # poner la misma clave ARI que en ari.conf
npm run migrar
npm run crear-admin -- --usuario admin --nombre "Administrador"   # pide la clave
npm run dev
```

Verificar: `curl http://localhost:3000/api/salud` debe responder `{"postgres":true,"redis":true,"asterisk":true}`.

## 7. Prueba de punta a punta (criterio de "semana 1 lista")

1. Registrar un softphone WebRTC como `1001` contra `wss://IP_DEL_SERVIDOR:8089/ws`. Para la prueba sirve cualquier cliente web basado en JsSIP o SIP.js; el propio llega en la semana 3.
2. Marcar un celular propio.
3. En los logs del backend debe aparecer `StasisStart` con `args: ["agente", "<numero>"]`.

En la semana 1 el backend solo **registra** el evento; la conexión real con el gateway (originar + bridge) es el primer objetivo de la semana 2. Para confirmar antes que el gateway saca llamadas, desde la consola de Asterisk:

```
channel originate PJSIP/<celular>@dinstar_10 application Playback hello-world
```

Si el celular suena y se escucha "Hello world", la infraestructura está lista.

## Arranque automático (systemd)

```bash
sudo deploy/instalar-servicios.sh                       # Asterisk + backend + panel arrancan con la PC
```

Antes, cortar el backend o el panel que estén corriendo a mano (usan los puertos 3000 y 5173). Para la VPN de desarrollo, su clave tiene que estar guardada "para todos los usuarios" en NetworkManager, si no, después de un reinicio no conecta hasta que alguien inicia sesión.
