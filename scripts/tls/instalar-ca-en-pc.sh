#!/bin/bash
# Instala la CA interna del discador en una PC de la oficina (Ubuntu/Linux Mint/Debian),
# para que el navegador confíe en el panel (https://...) y en el teléfono del navegador (wss://...).
#
#   curl -fsSk https://SERVIDOR:5173/api/instalar-ca.sh | sudo bash
#
# El backend sirve este script con la CA ya incluida (reemplaza el marcador del heredoc). Hace tres cosas:
#   1. la agrega al sistema (update-ca-certificates),
#   2. la agrega a Firefox con una política (vale para el Firefox de snap y el de .deb),
#   3. la agrega a Chrome/Chromium de cada usuario de la PC (base NSS).
# Después hay que cerrar TODAS las ventanas del navegador y volver a abrirlo (el certificado
# se lee al arrancar).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Correr con sudo" >&2; exit 1; }

NOMBRE="Discador - CA interna"
CA=/usr/local/share/ca-certificates/discador.crt
mkdir -p /usr/local/share/ca-certificates
cat > "$CA" <<'PEM'
__CA_PEM__
PEM
chmod 644 "$CA"
update-ca-certificates >/dev/null
echo "1/3 CA agregada al sistema"

# Firefox: política de empresa (la lee también el Firefox de snap desde /etc/firefox/policies)
for DIR in /etc/firefox/policies /usr/lib/firefox/distribution; do
  mkdir -p "$DIR"
  cp "$CA" "$DIR/discador.crt"
  python3 - "$DIR/policies.json" "$DIR/discador.crt" <<'PY'
import json, os, sys
ruta, cert = sys.argv[1], sys.argv[2]
datos = json.load(open(ruta)) if os.path.exists(ruta) else {}
pol = datos.setdefault('policies', {}).setdefault('Certificates', {})
instalar = pol.setdefault('Install', [])
if cert not in instalar:
    instalar.append(cert)
json.dump(datos, open(ruta, 'w'), indent=2)
PY
done
echo "2/3 CA agregada a Firefox (reiniciar Firefox)"

# Chrome / Chromium: base NSS de cada usuario
if ! command -v certutil >/dev/null; then
  apt-get install -y -qq libnss3-tools >/dev/null 2>&1 || echo "   (no se pudo instalar libnss3-tools: Chrome no queda configurado)"
fi
if command -v certutil >/dev/null; then
  for HOME_USUARIO in /home/*; do
    USUARIO=$(basename "$HOME_USUARIO")
    id "$USUARIO" >/dev/null 2>&1 || continue
    DB="$HOME_USUARIO/.pki/nssdb"
    sudo -u "$USUARIO" mkdir -p "$DB"
    [ -f "$DB/cert9.db" ] || sudo -u "$USUARIO" certutil -d "sql:$DB" -N --empty-password
    sudo -u "$USUARIO" certutil -d "sql:$DB" -D -n "$NOMBRE" 2>/dev/null || true
    sudo -u "$USUARIO" certutil -d "sql:$DB" -A -t "C,," -n "$NOMBRE" -i "$CA"
    # Firefox (snap y .deb): también directo en cada perfil, por si no toma la política
    for PERFIL in "$HOME_USUARIO"/snap/firefox/common/.mozilla/firefox/*/ "$HOME_USUARIO"/.mozilla/firefox/*/; do
      [ -f "$PERFIL/cert9.db" ] || continue
      sudo -u "$USUARIO" certutil -d "sql:$PERFIL" -D -n "$NOMBRE" 2>/dev/null || true
      sudo -u "$USUARIO" certutil -d "sql:$PERFIL" -A -t "C,," -n "$NOMBRE" -i "$CA"
    done
  done
  echo "3/3 CA agregada a Chrome/Chromium y a los perfiles de Firefox"
fi
echo "Listo. Huella de la CA:"
openssl x509 -in "$CA" -noout -fingerprint -sha256
