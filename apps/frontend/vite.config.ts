import { existsSync, readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo Vite sirve el panel y reenvía /api (HTTP y WebSocket) al backend.
// En producción el backend sirve los archivos compilados de dist/.
//
// HTTPS con el certificado de la CA interna (scripts/tls/crear-certificados.sh): las PCs de la
// oficina entran por https://<IP>:5173 (el micrófono del navegador exige HTTPS). Sin certificado,
// queda en HTTP solo para esta PC.
const DIR_TLS = process.env.DISCADOR_TLS_DIR ?? '/etc/discador/tls';
const conTls = existsSync(`${DIR_TLS}/servidor.key`) && existsSync(`${DIR_TLS}/servidor-cadena.crt`);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: conTls ? '0.0.0.0' : '127.0.0.1',
    https: conTls ? { key: readFileSync(`${DIR_TLS}/servidor.key`), cert: readFileSync(`${DIR_TLS}/servidor-cadena.crt`) } : undefined,
    // La extensión de Chrome (avisos del IVR) llama a la API desde chrome-extension://
    cors: { origin: [/^chrome-extension:\/\//, /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/] },
    proxy: {
      '/api': { target: 'http://localhost:3000', ws: true },
    },
  },
});
