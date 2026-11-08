# Asterisk 22 compilado (la misma versión probada en desarrollo) con la configuración del repo.
# La compilación tarda 10-20 minutos la primera vez; después queda en la caché de Docker.
FROM debian:bookworm-slim

ARG ASTERISK_VERSION=22.11.0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget build-essential sox \
 && cd /usr/src \
 && wget -q "https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz" \
 && tar xzf "asterisk-${ASTERISK_VERSION}.tar.gz" \
 && cd "asterisk-${ASTERISK_VERSION}" \
 && contrib/scripts/install_prereq install \
 && ./configure --with-pjproject-bundled --with-jansson-bundled \
 # Con los valores por defecto vienen res_pjsip, res_ari, app_amd, res_http_websocket, res_srtp,
 # los sonidos en inglés y la música en espera
 && make menuselect.makeopts \
 && make -j"$(nproc)" \
 && make install \
 && make samples \
 && cd / && rm -rf /usr/src/asterisk-* \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Configuración del repo (sin el simulador de desarrollo)
COPY asterisk/pjsip.conf asterisk/http.conf asterisk/ari.conf asterisk/rtp.conf \
     asterisk/extensions.conf asterisk/indications.conf /etc/asterisk/
COPY docker/asterisk/arrancar.sh /usr/local/bin/arrancar-asterisk
RUN chmod +x /usr/local/bin/arrancar-asterisk

CMD ["arrancar-asterisk"]
