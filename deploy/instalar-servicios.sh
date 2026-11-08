#!/bin/bash
# Instala y habilita los servicios del discador para que arranquen con la PC, y los arranca.
#   sudo deploy/instalar-servicios.sh                     # Asterisk + backend + panel
# Si había un backend o un panel corriendo a mano (npm run dev / dev:panel), cortarlos antes:
# los servicios usan los mismos puertos (3000 y 5173).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Correr con sudo" >&2; exit 1; }
USUARIO="${SUDO_USER:?correr con sudo desde el usuario que corre el discador}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

instalar() {
  sed -e "s#__USUARIO__#$USUARIO#g" -e "s#__DIR__#$DIR#g" "$DIR/deploy/systemd/$1" > "/etc/systemd/system/$1"
  echo "  $1"
}
echo "Instalando:"
instalar discador-backend.service
instalar discador-panel.service
systemctl daemon-reload
SERVICIOS=(asterisk discador-backend discador-panel)
systemctl enable docker "${SERVICIOS[@]}"
systemctl restart "${SERVICIOS[@]}"
sleep 5
systemctl --no-pager --lines=0 status "${SERVICIOS[@]}" | grep -E "●|Active:"
