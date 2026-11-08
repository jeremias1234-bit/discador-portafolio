# Panel: el frontend compilado servido por nginx con HTTPS en el 5173, que además reenvía /api
# (HTTP, WebSocket y la espera larga de la extensión) al backend.
FROM node:24-bookworm-slim AS compilacion
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci -w @discador/frontend
COPY apps/frontend apps/frontend
RUN npm run build -w @discador/frontend

FROM nginx:1.27-alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY docker/panel/nginx.conf /etc/nginx/conf.d/discador.conf
COPY --from=compilacion /app/apps/frontend/dist /usr/share/nginx/html
