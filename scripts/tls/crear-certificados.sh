#!/bin/bash
# Autoridad certificadora propia + certificado del servidor para HTTPS/WSS en la LAN.
#
#   sudo scripts/tls/crear-certificados.sh [IP o nombre ...]
#
# - La CA se crea una sola vez (/etc/discador/ca). Las PCs la instalan una vez con
#   instalar-ca-en-pc.sh y desde ahí confían en cualquier certificado que emita.
# - El certificado del servidor (/etc/discador/tls) se puede volver a emitir cuando cambian
#   las IPs (por ejemplo en la migración a producción) sin tocar las PCs.
# - Sin argumentos usa las IPv4 de la máquina (salvo docker) más localhost.
# La clave de la CA nunca sale de esta máquina ni va al repo.
set -euo pipefail

DIR_CA=/etc/discador/ca
DIR_TLS=/etc/discador/tls
DUENO="${SUDO_USER:-root}"   # el usuario que corre el backend y el panel
# Grupo que lee la clave: el de Asterisk si está instalado en la máquina; con Docker, root
GRUPO=asterisk
getent group asterisk >/dev/null || GRUPO=root
DIAS_CA=3650
DIAS_SERVIDOR=825

[ "$(id -u)" = 0 ] || { echo "Correr con sudo" >&2; exit 1; }

if [ $# -gt 0 ]; then
  NOMBRES=("$@")
else
  mapfile -t NOMBRES < <(ip -4 -o addr show | awk '$2 !~ /^(docker|br-|veth)/ {split($4, a, "/"); print a[1]}')
  NOMBRES+=(localhost)
fi

# --- CA (solo la primera vez) ---
mkdir -p "$DIR_CA"
chmod 755 "$DIR_CA"
if [ ! -f "$DIR_CA/ca.key" ]; then
  openssl genrsa -out "$DIR_CA/ca.key" 4096
  chmod 600 "$DIR_CA/ca.key"
  openssl req -x509 -new -key "$DIR_CA/ca.key" -sha256 -days "$DIAS_CA" -out "$DIR_CA/ca.crt" \
    -subj "/O=Discador/CN=Discador - CA interna" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 644 "$DIR_CA/ca.crt"
  echo "CA creada en $DIR_CA"
else
  echo "CA existente en $DIR_CA (no se toca)"
fi

# --- Certificado del servidor ---
SAN=""
for n in "${NOMBRES[@]}"; do
  if [[ "$n" =~ ^[0-9.]+$ ]]; then SAN+="IP:$n,"; else SAN+="DNS:$n,"; fi
done
SAN="${SAN%,}"
mkdir -p "$DIR_TLS"
TMP=$(mktemp -d)
openssl genrsa -out "$TMP/servidor.key" 2048
openssl req -new -key "$TMP/servidor.key" -out "$TMP/servidor.csr" -subj "/O=Discador/CN=discador"
openssl x509 -req -in "$TMP/servidor.csr" -CA "$DIR_CA/ca.crt" -CAkey "$DIR_CA/ca.key" -CAcreateserial \
  -out "$TMP/servidor.crt" -days "$DIAS_SERVIDOR" -sha256 \
  -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' "$SAN")
# Cadena completa (servidor + CA) para los clientes que no la tengan
cat "$TMP/servidor.crt" "$DIR_CA/ca.crt" > "$TMP/servidor-cadena.crt"
install -m 640 -o "$DUENO" -g "$GRUPO" "$TMP/servidor.key" "$DIR_TLS/servidor.key"
install -m 644 -o "$DUENO" -g "$GRUPO" "$TMP/servidor.crt" "$DIR_TLS/servidor.crt"
install -m 644 -o "$DUENO" -g "$GRUPO" "$TMP/servidor-cadena.crt" "$DIR_TLS/servidor-cadena.crt"
rm -rf "$TMP"
chown "$DUENO":"$GRUPO" "$DIR_TLS"
chmod 750 "$DIR_TLS"
echo "Certificado del servidor para: $SAN"

# Asterisk (WSS de los softphones) toma el certificado nuevo
if command -v asterisk >/dev/null && asterisk -rx "core show version" >/dev/null 2>&1; then
  asterisk -rx "module reload http" >/dev/null && echo "Asterisk recargado (http.conf)"
fi
# Con Docker: docker compose -f compose.produccion.yml restart asterisk panel
echo "Listo. Huella de la CA (para verificar en las PCs):"
openssl x509 -in "$DIR_CA/ca.crt" -noout -fingerprint -sha256
