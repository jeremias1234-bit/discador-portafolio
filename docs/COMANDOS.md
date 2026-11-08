# Comandos del discador (producción en Docker)

Todos se corren en Ubuntu (WSL), dentro de la carpeta del repo:

```bash
cd ~/discador
```

## Levantar y apagar
| Para | Comando |
|---|---|
| Levantar todo | `docker compose up -d` |
| Levantar y recompilar (después de actualizar) | `docker compose up -d --build` |
| Ver si está todo corriendo | `docker compose ps` |
| Reiniciar todo | `docker compose restart` |
| Reiniciar uno solo | `docker compose restart backend` (o `asterisk`, `panel`, `postgres`, `redis`) |
| Apagar todo (conserva los datos) | `docker compose down` |
| ⚠️ Apagar y **borrar todos los datos** | `docker compose down -v` (no usar salvo que se quiera empezar de cero) |

## Ver qué pasa
| Para | Comando |
|---|---|
| Salud general | `curl -sk https://192.168.1.10:5173/api/salud` → `{"postgres":true,"redis":true,"asterisk":true}` |
| Logs del backend en vivo | `docker compose logs -f --tail 100 backend` |
| Logs de Asterisk | `docker compose logs -f --tail 100 asterisk` |
| Logs del panel (nginx) | `docker compose logs -f --tail 100 panel` |
| Uso de CPU y memoria | `docker stats` |

`Ctrl+C` corta la vista de los logs, no apaga nada.

## Asterisk
| Para | Comando |
|---|---|
| Consola interactiva | `docker compose exec asterisk asterisk -rvvv` (salir con `exit`) |
| Estado de los gateways | `docker compose exec asterisk asterisk -rx "pjsip show contacts"` (tiene que decir `Avail`) |
| Internos y gateways | `docker compose exec asterisk asterisk -rx "pjsip show endpoints"` |
| Llamadas en curso | `docker compose exec asterisk asterisk -rx "core show channels"` |
| App del discador conectada | `docker compose exec asterisk asterisk -rx "ari show apps"` (tiene que aparecer `discador`) |
| Recargar la configuración SIP | `docker compose exec asterisk asterisk -rx "module reload res_pjsip.so"` |

## Usuarios
| Para | Comando |
|---|---|
| Crear un administrador | `docker compose exec backend node dist/scripts/crear-admin.js --usuario admin2 --nombre "Nombre"` |

El resto de los usuarios (y los cambios de clave) se hacen desde el panel: **Administración → Usuarios**.

## Actualizar a una versión nueva
```bash
cd ~/discador
git pull
docker compose up -d --build
```
Las migraciones de la base se aplican solas al arrancar el backend.

## Respaldo de la base
```bash
docker compose exec -T postgres pg_dump -U discador -Fc discador > ~/respaldo-$(date +%F).dump
```
Restaurar (pisa la base actual; preguntar antes):
```bash
docker compose exec -T postgres pg_restore -U discador -d discador --clean --if-exists --no-owner < ~/respaldo-AAAA-MM-DD.dump
docker compose restart backend
```
Los respaldos tienen datos de clientes: guardarlos en un disco aparte, nunca en el repo ni por chat o mail.

## Certificados
| Para | Comando |
|---|---|
| Rehacer el certificado (si cambia la IP) | `sudo scripts/tls/crear-certificados.sh 192.168.1.10 localhost 127.0.0.1 && docker compose restart asterisk panel` |
| Ver la huella de la CA | `openssl x509 -in /etc/discador/ca/ca.crt -noout -fingerprint -sha256` |
| Instalar la CA en una PC Linux | `curl -fsSk https://192.168.1.10:5173/api/instalar-ca.sh \| sudo bash` |
| Instalar la CA en una PC Windows (PowerShell admin) | `curl.exe -k -o $env:TEMP\discador-ca.crt https://192.168.1.10:5173/api/ca.crt; certutil -addstore -f Root $env:TEMP\discador-ca.crt` |

## Windows (PowerShell como administrador)
| Para | Comando |
|---|---|
| Reiniciar WSL entero | `wsl --shutdown` y volver a abrir Ubuntu |
| Ver si WSL está corriendo | `wsl -l -v` |
| Arrancar la tarea que mantiene vivo el discador | `Start-ScheduledTask -TaskName "Discador WSL"` |

Si después de reiniciar la PC no levanta solo: abrir Ubuntu, `cd ~/discador` y `docker compose up -d`. Si dice que Docker no corre: `sudo systemctl start docker`.

## Si algo no anda
| Síntoma | Probar |
|---|---|
| El panel no abre | `docker compose ps`; `docker compose restart panel backend` |
| Gateway "Unavailable" | `docker compose exec asterisk asterisk -rx "pjsip show contacts"`; ping al Dinstar desde Ubuntu (`ping 192.168.1.35`); en el Dinstar, trunk 31 con Remote Address `192.168.1.10` |
| Llamadas con error 503 | el trunk del Dinstar no apunta a `192.168.1.10` o no está en el Trunk Group de la regla IP→Tel |
| Sin audio | regla del firewall de Windows UDP 10000-20000 (`docs/INSTALACION-WSL.md`, 1.4) |
| Softphone "sin conexión" | CA instalada en la PC, puerto 8089 abierto, `docker compose logs asterisk` |
