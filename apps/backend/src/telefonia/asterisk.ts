// Genera pjsip_discador.conf desde la base (gateways e internos de usuarios activos) y
// recarga res_pjsip por ARI. Así todo se administra desde el panel, sin tocar archivos.
import { readFile, writeFile } from 'node:fs/promises';
import type pg from 'pg';
import type { AriCliente } from '../ari/cliente.js';

/** Quita lo que podría romper la sintaxis del archivo (saltos de línea, corchetes, comillas). */
function limpio(texto: string): string {
  return texto.replace(/[\r\n"[\];]/g, ' ').trim();
}

export async function generarPjsip(db: pg.Pool): Promise<string> {
  const [gateways, usuarios] = await Promise.all([
    db.query<{ endpoint_pjsip: string; ip: string }>(
      'SELECT endpoint_pjsip, host(ip) AS ip FROM gateways WHERE activo AND ip IS NOT NULL ORDER BY orden, id',
    ),
    db.query<{ nombre: string; interno_sip: string; clave_sip: string; tipo_telefono: string }>(
      `SELECT nombre, interno_sip, clave_sip, tipo_telefono FROM usuarios
        WHERE activo AND interno_sip IS NOT NULL AND clave_sip IS NOT NULL ORDER BY interno_sip`,
    ),
  ]);

  const partes = ['; GENERADO por el backend del discador desde la base. No editar a mano.', ''];
  for (const g of gateways.rows) {
    const n = limpio(g.endpoint_pjsip);
    partes.push(
      `[${n}](dinstar)`, `aors=${n}`,
      `[${n}](dinstar-aor)`, `contact=sip:${g.ip}:5060`,
      `[${n}](dinstar-identify)`, `endpoint=${n}`, `match=${g.ip}`, '',
    );
  }
  for (const u of usuarios.rows) {
    const n = limpio(u.interno_sip);
    const plantilla = u.tipo_telefono === 'externo' ? 'agente-udp' : 'agente-webrtc';
    partes.push(
      `[${n}](${plantilla})`, `auth=${n}`, `aors=${n}`, `callerid="${limpio(u.nombre)}" <${n}>`,
      `[${n}](auth-userpass)`, `username=${n}`, `password=${limpio(u.clave_sip)}`,
      `[${n}](agente-aor)`, '',
    );
  }
  return partes.join('\n');
}

/** Reescribe el archivo solo si cambió y recarga PJSIP. Devuelve true si hubo cambios. */
export async function sincronizarPjsip(db: pg.Pool, ari: AriCliente, archivo: string): Promise<boolean> {
  const nuevo = await generarPjsip(db);
  const actual = await readFile(archivo, 'utf8').catch(() => '');
  if (nuevo === actual) return false;
  await writeFile(archivo, nuevo);
  await ari.recargarModulo('res_pjsip.so');
  return true;
}
