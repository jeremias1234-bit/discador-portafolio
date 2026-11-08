# Instalación en la oficina: Windows + WSL2 + Docker

El discador entero corre en contenedores Docker dentro de WSL2 (Ubuntu) en una PC con Windows de la oficina. En esta guía, `IP_SERVIDOR` es la IP fija de esa PC en la LAN (por ejemplo `192.168.1.50`).

```
Windows (IP fija en la LAN)
└─ WSL2 Ubuntu, red "mirrored" → comparte la IP de Windows
   └─ Docker Engine
      ├─ postgres   127.0.0.1:5432
      ├─ redis      127.0.0.1:6379
      ├─ asterisk   SIP 5060/udp · audio 10000-20000/udp · WSS 8089 · ARI 127.0.0.1:8088
      ├─ backend    3000 (API, motor, conmutador)
      └─ panel      https://IP_SERVIDOR:5173 (nginx: panel compilado + /api)
```

Todos los contenedores usan la red del host (`network_mode: host`). Con la red *mirrored* de WSL, "el host" tiene la IP de Windows, así que los Dinstar y las PCs le hablan directo a `IP_SERVIDOR`.

## 1. Windows (PowerShell como administrador)

### 1.1 IP fija
Darle a la PC una IP fija en la LAN de la oficina (`192.168.1.0/24`, puerta de enlace `192.168.1.1`), en la configuración del adaptador o reservándola en el router. Esa es `IP_SERVIDOR`.

### 1.2 WSL2 con Ubuntu
Requiere Windows 11 22H2 o más nuevo (la red *mirrored* no existe en Windows 10).

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
```

Reiniciar si lo pide, abrir "Ubuntu 24.04" y crear el usuario de Linux.

### 1.3 Red mirrored
Crear `C:\Users\<usuario>\.wslconfig` con:

```ini
[wsl2]
networkingMode=mirrored
firewall=true
dnsTunneling=true
memory=6GB

[experimental]
hostAddressLoopback=true
```

Después: `wsl --shutdown` y volver a abrir Ubuntu. Verificar dentro de Ubuntu con `ip -4 addr`: tiene que aparecer `IP_SERVIDOR`.

### 1.4 Firewall
Permitir conexiones entrantes a WSL (firewall de Hyper-V) y abrir los puertos solo para la red local:

```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow

New-NetFirewallRule -DisplayName "Discador SIP"   -Direction Inbound -Protocol UDP -LocalPort 5060        -RemoteAddress LocalSubnet -Action Allow
New-NetFirewallRule -DisplayName "Discador audio" -Direction Inbound -Protocol UDP -LocalPort 10000-20000 -RemoteAddress LocalSubnet -Action Allow
New-NetFirewallRule -DisplayName "Discador panel" -Direction Inbound -Protocol TCP -LocalPort 5173,8089   -RemoteAddress LocalSubnet -Action Allow
```

Si se va a entrar desde la VPN (`10.0.0.0/24`), agregar esa subred a `-RemoteAddress` (por ejemplo `-RemoteAddress LocalSubnet,10.0.0.0/24`).

Revisar que Windows no tenga reservados los puertos del audio:

```powershell
netsh int ipv4 show excludedportrange protocol=udp
```

Si algún rango se cruza con 10000-20000, hay que avisar: se cambian `RTP_INICIO`/`RTP_FIN` en `.env` y la regla del firewall.

Revisar también que nada ocupe el SIP ni el audio (por ejemplo, otra VPN puede ocupar el UDP 5060 y cientos de puertos entre 10000 y 20000). Desde Ubuntu:

```bash
python3 -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('0.0.0.0',5060))"
```

Si da `Address already in use`, poner `PUERTO_SIP=5061` en `.env` (y el mismo puerto en el Remote Port de los Dinstar y en la regla del firewall).

Si en la PC corre el **servicio de red**, usa el TCP 8088 (el mismo que ARI) y el UDP 27001 y 29810-29817: mover ARI con `PUERTO_ARI` y dejar el rango del audio fuera de esos puertos. En la oficina quedó `PUERTO_SIP=5061`, `RTP_INICIO=20000`, `RTP_FIN=24999`, `PUERTO_ARI=8188`.

### 1.5 Que arranque solo
WSL apaga Ubuntu cuando no queda ninguna terminal abierta. Para que el discador quede siempre prendido, incluso sin nadie logueado en Windows, crear una tarea programada:

```powershell
$accion = New-ScheduledTaskAction -Execute "C:\Windows\System32\wsl.exe" -Argument "-d Ubuntu-24.04 --exec /bin/sh -c 'sleep infinity'"
$disparador = New-ScheduledTaskTrigger -AtStartup
$opciones = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Discador WSL" -Action $accion -Trigger $disparador -Settings $opciones -User "<usuario de Windows>" -Password "<su clave>" -RunLevel Highest
```

También conviene desactivar la suspensión y la hibernación de la PC en *Energía*, y las actualizaciones automáticas con reinicio en horario de trabajo.

## 2. Ubuntu (WSL)

### 2.1 systemd y Docker Engine
Usar **Docker Engine dentro de Ubuntu**, no Docker Desktop: con Docker Desktop la red del host no es la de WSL.

```bash
# systemd (lo necesita Docker para arrancar solo)
printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
# desde PowerShell: wsl --shutdown, y volver a abrir Ubuntu

sudo apt update && sudo apt install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER      # cerrar y abrir la terminal
sudo systemctl enable --now docker
sudo timedatectl set-timezone America/Argentina/Buenos_Aires
```

### 2.2 Repo
El repo es privado: hace falta un token de GitHub con acceso de lectura, o `gh auth login`.

```bash
git clone https://github.com/jeremias1234-bit/discador.git ~/discador
cd ~/discador
```

### 2.3 Certificados (HTTPS y WSS)
Una sola vez. Crea la CA propia y el certificado del servidor con su IP:

```bash
sudo scripts/tls/crear-certificados.sh IP_SERVIDOR localhost 127.0.0.1
```

Anotar la huella SHA-256 que imprime al final: las PCs la ven al instalar la CA. Si algún día cambia la IP, se vuelve a correr (la CA se conserva) y después `docker compose restart asterisk panel`.

### 2.4 Claves

```bash
cp docker/env.produccion.ejemplo .env
sed -i "s/CAMBIAR_CLAVE_POSTGRES/$(openssl rand -hex 16)/; s/CAMBIAR_CLAVE_ARI/$(openssl rand -hex 16)/" .env
chmod 600 .env
```

### 2.5 Levantar

```bash
docker compose up -d --build
```

La primera vez tarda 15-25 minutos, porque compila Asterisk. Después:

```bash
docker compose ps                     # los 5 en "running" / "healthy"
docker compose logs -f backend        # "ARI conectado" y "Server listening"
docker compose exec asterisk asterisk -rx "pjsip show endpoints"
```

### 2.6 Primer administrador

```bash
docker compose exec backend node dist/scripts/crear-admin.js --usuario admin --nombre "Administrador"
```

Pide la clave dos veces (mínimo 8 caracteres). Entrar a `https://IP_SERVIDOR:5173`.

## 3. Puesta en marcha desde el panel

1. **Administración → Gateways:** para cada Dinstar, IP fija, canales y activo. El backend regenera la configuración de Asterisk solo. Configurar cada Dinstar según `docs/INSTALACION.md` (sección 5).
2. **Administración → No Llame:** importar el padrón oficial (el `.txt` que descarga la empresa del portal).
3. **Configuración:** horario, feriados, nivel de rendimiento, tipificaciones.
4. **Usuarios:** vendedores, supervisores y administradores (con "Recibe IVR" para los que reciben avisos).
5. **Audios** y **Campañas** (sección **IVR** para las de aviso).

## 4. PCs de la oficina

- **Linux:** `curl -fsSk https://IP_SERVIDOR:5173/api/instalar-ca.sh | sudo bash` y reiniciar el navegador.
- **Windows** (PowerShell como administrador):
  ```powershell
  curl.exe -k -o $env:TEMP\discador-ca.crt https://IP_SERVIDOR:5173/api/ca.crt; certutil -addstore -f Root $env:TEMP\discador-ca.crt
  ```
  Y cerrar Chrome del todo.
- **Extensión de avisos del IVR:** en el panel, **IVR → Descargar extensión de Chrome** (ya viene apuntando al servidor). Se descomprime y se carga en `chrome://extensions` con *Modo de desarrollador* → *Cargar descomprimida*.

Verificación: `https://IP_SERVIDOR:5173` abre con candado, sin advertencias.

## 5. Operación

| Tarea | Comando (en `~/discador`) |
|---|---|
| Estado | `docker compose ps` |
| Logs | `docker compose logs -f --tail 200 backend` (o `asterisk`, `panel`) |
| Consola de Asterisk | `docker compose exec asterisk asterisk -rvvv` |
| Actualizar | `git pull && docker compose up -d --build` (las migraciones se aplican solas al arrancar el backend) |
| Reiniciar todo | `docker compose restart` |
| Respaldo de la base | `docker compose exec -T postgres pg_dump -U discador -Fc discador > ~/respaldo-$(date +%F).dump` |

Los respaldos tienen datos de clientes: nunca van al repo y no se mandan por chat ni por mail. Guardarlos en un disco aparte.

Los datos viven en volúmenes de Docker (`discador_pgdata`, `discador_audios`, `discador_grabaciones`, `discador_compartido`). `docker compose down` los conserva; `down -v` **los borra**.

## 6. Traer los datos de la PC de desarrollo (opcional)

Sirve para no volver a cargar usuarios, campañas, audios y el padrón. Hay que hacerlo **antes** de usar el panel nuevo. En la PC de desarrollo:

```bash
docker exec discador-postgres-1 pg_dump -U discador -Fc discador > discador.dump
sudo tar czf audios.tgz -C /var/lib/asterisk/sounds/campanas .
```

Copiar los dos archivos a la PC de la oficina por pendrive o por la red interna (tienen datos de clientes: no por chat ni por mail). En la oficina:

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U discador -d discador --clean --if-exists --no-owner < discador.dump
docker compose up -d
docker compose cp audios.tgz backend:/tmp/audios.tgz
docker compose exec backend tar xzf /tmp/audios.tgz -C /var/lib/asterisk/sounds/campanas
```

Después revisar en **Gateways** las IPs de los Dinstar (en desarrollo `dinstar_10` era `192.168.1.35`) y desactivar el gateway `simulador`, que es solo de desarrollo.

## 7. Problemas comunes

| Síntoma | Revisar |
|---|---|
| El panel no abre desde otra PC | `ip -4 addr` en Ubuntu muestra `IP_SERVIDOR` (red mirrored); firewall de Windows y de Hyper-V (1.4) |
| Gateway "Unavailable" en el monitor | Desde Ubuntu, `ping` al Dinstar; trunk del Dinstar apuntando a `IP_SERVIDOR` (`docs/INSTALACION.md`, sección 5) |
| Llamada sin audio o de un solo lado | regla UDP 10000-20000; `netsh int ipv4 show excludedportrange protocol=udp` |
| El softphone no registra ("Teléfono sin conexión") | CA instalada en la PC; puerto 8089 abierto; `docker compose ... logs asterisk` |
| No arranca después de reiniciar Windows | la tarea "Discador WSL" (1.5); `systemctl status docker` en Ubuntu |
