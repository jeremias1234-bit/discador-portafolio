# Backend (Node 24 + TypeScript compilado). Al arrancar aplica las migraciones pendientes.
FROM node:24-bookworm-slim AS compilacion
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci -w @discador/backend
COPY apps/backend apps/backend
RUN npm run build -w @discador/backend

FROM node:24-bookworm-slim
# sox convierte los audios que se suben (WAV/MP3) al formato de Asterisk
RUN apt-get update && apt-get install -y --no-install-recommends sox libsox-fmt-all \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --omit=dev -w @discador/backend && npm cache clean --force
COPY --from=compilacion /app/apps/backend/dist apps/backend/dist
# Lo que el backend lee del repo: migraciones, instalador de la CA y las extensiones de Chrome
# (la de los vendedores y el Detector de leads de la PC del bot)
COPY db db
COPY scripts/tls/instalar-ca-en-pc.sh scripts/tls/
COPY apps/extension-chrome apps/extension-chrome
COPY apps/extension-detector apps/extension-detector
WORKDIR /app/apps/backend
CMD ["sh", "-c", "node dist/db/migrar.js && exec node dist/index.js"]
