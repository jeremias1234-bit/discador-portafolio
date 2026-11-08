#!/bin/sh
# Arranque de Asterisk en el contenedor: clave de ARI desde el entorno y el archivo de PJSIP que
# genera el backend (gateways e internos) en el volumen compartido.
set -eu
: "${ARI_PASSWORD:?Falta ARI_PASSWORD (ver .env)}"
sed -i "s/^password=.*/password=${ARI_PASSWORD}/" /etc/asterisk/ari.conf

# Puertos de SIP y del audio (.env): solo cambian si en la máquina ya están ocupados
sed -i "s/^bind=0\.0\.0\.0:[0-9]*$/bind=0.0.0.0:${PUERTO_SIP:-5060}/" /etc/asterisk/pjsip.conf
sed -i "s/^rtpstart=.*/rtpstart=${RTP_INICIO:-10000}/; s/^rtpend=.*/rtpend=${RTP_FIN:-20000}/" /etc/asterisk/rtp.conf
sed -i "s/^bindport=.*/bindport=${PUERTO_ARI:-8088}/" /etc/asterisk/http.conf

mkdir -p /var/lib/discador/pjsip /var/lib/asterisk/sounds/campanas /var/spool/asterisk/recording
[ -f /var/lib/discador/pjsip/pjsip_discador.conf ] || : > /var/lib/discador/pjsip/pjsip_discador.conf
ln -sf /var/lib/discador/pjsip/pjsip_discador.conf /etc/asterisk/pjsip_discador.conf

[ -f /etc/discador/tls/servidor.key ] || echo "AVISO: falta el certificado en /etc/discador/tls (scripts/tls/crear-certificados.sh): el WSS de los softphones no va a andar" >&2
exec asterisk -f -vvv
