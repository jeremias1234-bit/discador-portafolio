import 'dotenv/config';
import { z } from 'zod';

const esquema = z.object({
  PUERTO_API: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  ARI_URL: z.string().url().default('http://localhost:8088'),
  ARI_USUARIO: z.string().min(1),
  ARI_PASSWORD: z.string().min(1),
  ARI_APP: z.string().min(1).default('discador'),
  // Archivo de PJSIP que genera el backend (incluido desde pjsip.conf)
  ARCHIVO_PJSIP: z.string().default('/etc/asterisk/pjsip_discador.conf'),
  // Audios de campañas: el backend escribe, Asterisk lee (Playback(campanas/<archivo>))
  DIR_AUDIOS: z.string().default('/var/lib/asterisk/sounds/campanas'),
  // Grabaciones: las escribe Asterisk; el backend solo mide el espacio libre (se sirven y borran por ARI)
  DIR_GRABACIONES: z.string().default('/var/spool/asterisk/recording'),
  // Sesiones del panel: duración (se renueva con cada uso) y cookie solo por HTTPS
  // CA interna (pública) que instalan las PCs de la oficina: scripts/tls/crear-certificados.sh
  ARCHIVO_CA: z.string().default('/etc/discador/ca/ca.crt'),
  SESION_HORAS: z.coerce.number().positive().default(12),
  COOKIE_SEGURA: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const resultado = esquema.safeParse(process.env);
if (!resultado.success) {
  console.error('Configuración inválida (revisar .env):');
  for (const problema of resultado.error.issues) {
    console.error(`  ${problema.path.join('.')}: ${problema.message}`);
  }
  process.exit(1);
}

export const config = resultado.data;
