// Audios de las campañas (§1): se suben desde el panel, se convierten al formato de Asterisk
// (WAV 8 kHz, mono, 16 bits) con sox y quedan en DIR_AUDIOS para Playback(campanas/<archivo>).
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registrarEnBitacora } from '../bitacora.js';
import { config } from '../config.js';
import { leerMultipart } from './archivos.js';
import { requierePermiso, usuarioDe } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const ejecutar = promisify(execFile);
const FORMATOS = ['.wav', '.mp3', '.ogg', '.flac'];
const TAMANO_MAXIMO = 30 * 1024 * 1024;
const COLUMNAS = 'id, nombre, archivo, duracion_seg::float8 AS duracion_seg, subido_por, creado_en';
const esquemaId = z.object({ id: z.coerce.number().int().positive() });

/** Nombre de archivo seguro y único: a<timestamp>_<nombre-sin-acentos>. */
function nombreArchivo(nombre: string): string {
  const slug = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  return `a${Date.now()}_${slug || 'audio'}`;
}

export function rutasAudios(app: FastifyInstance, { db }: Dependencias): void {
  const ver = requierePermiso('campanas.ver', 'ivr.ver');

  app.get('/api/audios', { preHandler: ver }, async () => {
    const { rows } = await db.query(
      `SELECT ${COLUMNAS},
              (SELECT array_agg(c.id) FROM campanas c WHERE a.id IN (c.audio_id, c.audio_b_id)) AS campanas
         FROM audios a ORDER BY creado_en DESC`,
    );
    return rows;
  });

  // Para escucharlo en el panel
  app.get('/api/audios/:id/archivo', { preHandler: ver }, async (req, reply) => {
    const { id } = validar(esquemaId, req.params);
    const { rows } = await db.query<{ archivo: string }>('SELECT archivo FROM audios WHERE id = $1', [id]);
    if (!rows[0]) throw errorHttp(404, 'Audio no encontrado');
    const ruta = join(config.DIR_AUDIOS, `${rows[0].archivo}.wav`);
    const info = await stat(ruta).catch(() => null);
    if (!info) throw errorHttp(404, 'El archivo del audio no está en el servidor');
    return reply.type('audio/wav').header('Content-Length', info.size).send(createReadStream(ruta));
  });

  // Campo del formulario (antes del archivo): nombre
  app.post('/api/audios', { preHandler: requierePermiso('ivr.audios') }, async (req, reply) => {
    const yo = usuarioDe(req);
    const temporal = await mkdtemp(join(tmpdir(), 'audio-'));
    let destino: string | undefined;
    try {
      const { nombre, entrada } = await leerMultipart(req, async (archivo, campos) => {
        const ext = extname(archivo.filename).toLowerCase();
        if (!FORMATOS.includes(ext)) throw errorHttp(400, `Formato no soportado. Usar: ${FORMATOS.join(', ')}`);
        const buffer = await archivo.toBuffer();
        if (buffer.length > TAMANO_MAXIMO) throw errorHttp(413, 'El audio supera los 30 MB');
        const entrada = join(temporal, `original${ext}`);
        await writeFile(entrada, buffer);
        const nombre = (campos.nombre ?? '').trim() || archivo.filename.replace(/\.[^.]+$/, '');
        return { nombre: nombre.slice(0, 120), entrada };
      });

      const archivo = nombreArchivo(nombre);
      destino = join(config.DIR_AUDIOS, `${archivo}.wav`);
      try {
        await ejecutar('sox', [entrada, '-r', '8000', '-c', '1', '-b', '16', destino], { timeout: 60_000 });
      } catch (err) {
        throw errorHttp(400, `No se pudo convertir el audio: ${(err as { stderr?: string }).stderr?.trim() || (err as Error).message}`);
      }
      const { stdout } = await ejecutar('soxi', ['-D', destino]);
      const duracion = Math.round(Number(stdout.trim()) * 100) / 100;

      const { rows } = await db.query(
        `INSERT INTO audios (nombre, archivo, duracion_seg, subido_por) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNAS}`,
        [nombre, archivo, duracion, yo.id],
      );
      await registrarEnBitacora(db, {
        usuarioId: yo.id, accion: 'audio.subir', entidad: 'audios', entidadId: rows[0].id, ip: req.ip,
        detalle: { nombre, archivo, duracion_seg: duracion },
      });
      destino = undefined; // quedó registrado: no se borra
      return reply.code(201).send(rows[0]);
    } finally {
      await rm(temporal, { recursive: true, force: true });
      if (destino) await unlink(destino).catch(() => {});
    }
  });

  app.patch('/api/audios/:id', { preHandler: requierePermiso('ivr.audios') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { nombre } = validar(z.object({ nombre: z.string().trim().min(1).max(120) }).strict(), req.body);
    const { rows } = await db.query(`UPDATE audios SET nombre = $2 WHERE id = $1 RETURNING ${COLUMNAS}`, [id, nombre]);
    if (!rows[0]) throw errorHttp(404, 'Audio no encontrado');
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'audio.editar', entidad: 'audios', entidadId: id, detalle: { nombre }, ip: req.ip });
    return rows[0];
  });

  // Si una campaña lo usa, la base lo impide (FK RESTRICT) y se responde 409
  app.delete('/api/audios/:id', { preHandler: requierePermiso('ivr.audios') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { rows } = await db.query<{ archivo: string }>('DELETE FROM audios WHERE id = $1 RETURNING archivo', [id]);
    if (!rows[0]) throw errorHttp(404, 'Audio no encontrado');
    await unlink(join(config.DIR_AUDIOS, `${rows[0].archivo}.wav`)).catch(() => {});
    await registrarEnBitacora(db, { usuarioId: yo.id, accion: 'audio.borrar', entidad: 'audios', entidadId: id, detalle: rows[0], ip: req.ip });
    return { ok: true };
  });
}
