// No Llame (§8): importación del padrón oficial, lista propia y consulta.
// El padrón se reemplaza entero: COPY a una tabla de carga, tabla nueva con índice y
// swap de nombres en una transacción (bloqueo de milisegundos). Ver 001_esquema_inicial.sql.
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { from as copyFrom } from 'pg-copy-streams';
import { z } from 'zod';
import { registrarEnBitacora } from '../bitacora.js';
import { bloquearNumero, sqlBloqueado } from '../noLlame.js';
import { normalizarTelefono } from '../telefonos.js';
import { leerMultipart } from './archivos.js';
import { requierePermiso, usuarioDe } from './autenticacion.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const PERMISO = 'config.no_llame';
// Un padrón nuevo con menos de esta fracción del actual se rechaza salvo que se fuerce
const FRACCION_MINIMA = 0.5;

const esquemaTelefono = z.string().transform((v, ctx) => {
  const t = normalizarTelefono(v);
  if (!t) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'teléfono inválido' });
  return t ?? '';
});

export function rutasNoLlame(app: FastifyInstance, { db }: Dependencias): void {
  // Estado: tamaño del padrón, fecha de la última carga y alerta si está desactualizado
  app.get('/api/no-llame', { preHandler: requierePermiso(PERMISO) }, async () => {
    const { rows } = await db.query(
      `SELECT (SELECT count(*)::int FROM no_llame_padron) AS padron_registros,
              (SELECT count(*)::int FROM no_llame_propia) AS propia_registros,
              (SELECT (valor #>> '{}')::int FROM configuracion WHERE clave = 'no_llame.alerta_dias_padron') AS alerta_dias,
              (SELECT row_to_json(i) FROM (
                 SELECT id, archivo, fecha_padron, registros, estado, error, importado_por, iniciada_en, terminada_en
                   FROM no_llame_importaciones ORDER BY id DESC LIMIT 1) i) AS ultima_importacion,
              (SELECT max(terminada_en) FROM no_llame_importaciones WHERE estado = 'aplicada') AS ultima_aplicada_en`,
    );
    const r = rows[0];
    const dias = r.ultima_aplicada_en ? Math.floor((Date.now() - new Date(r.ultima_aplicada_en).getTime()) / 86_400_000) : null;
    return { ...r, dias_desde_ultima_carga: dias, desactualizado: dias === null || dias > (r.alerta_dias ?? 30) };
  });

  app.get('/api/no-llame/importaciones', { preHandler: requierePermiso(PERMISO) }, async () => {
    const { rows } = await db.query(
      `SELECT i.*, u.nombre AS importado_por_nombre FROM no_llame_importaciones i
         LEFT JOIN usuarios u ON u.id = i.importado_por ORDER BY i.id DESC LIMIT 50`,
    );
    return rows;
  });

  // Importación del padrón oficial (archivo descargado por la empresa del portal oficial).
  // Se toma el primer campo de cada línea; encabezados y líneas inválidas se cuentan y se saltean.
  // Campos del formulario (antes del archivo): fecha_padron (AAAA-MM-DD, opcional), forzar ('true')
  app.post('/api/no-llame/padron', { preHandler: requierePermiso(PERMISO) }, async (req) => {
    const yo = usuarioDe(req);
    const cliente = await db.connect();
    let importacionId: number | undefined;
    try {
      // Una importación a la vez
      const { rows: lock } = await cliente.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('no_llame.padron')) AS ok",
      );
      if (!lock[0]?.ok) throw errorHttp(409, 'Ya hay una importación del padrón en curso');

      return await leerMultipart(req, async (archivo, campos) => {
        const opciones = validar(
          z.object({
            fecha_padron: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato AAAA-MM-DD').optional(),
            forzar: z.enum(['true', 'false']).optional(),
          }),
          campos,
        );
        const { rows: imp } = await cliente.query<{ id: number }>(
          `INSERT INTO no_llame_importaciones (archivo, fecha_padron, importado_por) VALUES ($1, $2, $3) RETURNING id`,
          [archivo.filename, opciones.fecha_padron ?? null, yo.id],
        );
        importacionId = imp[0]!.id;

        await cliente.query('DROP TABLE IF EXISTS no_llame_padron_carga, no_llame_padron_nuevo');
        await cliente.query('CREATE UNLOGGED TABLE no_llame_padron_carga (telefono TEXT NOT NULL)');

        // Archivo -> líneas -> teléfono normalizado -> COPY, sin cargarlo entero en memoria
        let lineas = 0;
        let invalidas = 0;
        const aCopy = new Transform({
          objectMode: true,
          transform(linea: string, _enc, listo) {
            lineas++;
            const telefono = normalizarTelefono(linea.split(/[,;\t|]/)[0]);
            if (telefono) listo(null, telefono + '\n');
            else {
              invalidas++;
              listo();
            }
          },
        });
        const lector = createInterface({ input: archivo.file, crlfDelay: Infinity });
        await pipeline(Readable.from(lector), aCopy, cliente.query(copyFrom('COPY no_llame_padron_carga FROM STDIN')));
        if (archivo.file.truncated) throw errorHttp(413, 'El archivo supera el tamaño máximo');

        await cliente.query(
          'CREATE TABLE no_llame_padron_nuevo AS SELECT DISTINCT telefono FROM no_llame_padron_carga',
        );
        await cliente.query('ALTER TABLE no_llame_padron_nuevo ADD PRIMARY KEY (telefono)');
        const { rows: cuentas } = await cliente.query<{ nuevo: number; actual: number }>(
          `SELECT (SELECT count(*)::int FROM no_llame_padron_nuevo) AS nuevo,
                  (SELECT count(*)::int FROM no_llame_padron) AS actual`,
        );
        const { nuevo, actual } = cuentas[0]!;
        if (nuevo === 0) throw errorHttp(400, 'El archivo no tiene ningún teléfono válido');
        if (actual > 0 && nuevo < actual * FRACCION_MINIMA && opciones.forzar !== 'true') {
          throw errorHttp(
            400,
            `El padrón nuevo tiene ${nuevo} números y el actual ${actual}: parece un archivo incompleto. ` +
              'Si es correcto, repetí la importación con forzar=true.',
          );
        }

        // Swap atómico
        await cliente.query('BEGIN');
        await cliente.query('ALTER TABLE no_llame_padron RENAME TO no_llame_padron_viejo');
        await cliente.query('ALTER INDEX no_llame_padron_pkey RENAME TO no_llame_padron_viejo_pkey');
        await cliente.query('ALTER TABLE no_llame_padron_nuevo RENAME TO no_llame_padron');
        await cliente.query('ALTER INDEX no_llame_padron_nuevo_pkey RENAME TO no_llame_padron_pkey');
        await cliente.query('COMMIT');
        await cliente.query('DROP TABLE no_llame_padron_viejo, no_llame_padron_carga');

        // Los leads todavía no llamados que ahora están en el padrón salen de la cola
        const retirados = await cliente.query(
          `UPDATE leads SET estado = 'no_llamar'
            WHERE estado IN ('pendiente', 'reintentar')
              AND EXISTS (SELECT 1 FROM no_llame_padron p WHERE p.telefono = leads.telefono)`,
        );
        await cliente.query(
          "UPDATE no_llame_importaciones SET estado = 'aplicada', registros = $2, terminada_en = now() WHERE id = $1",
          [importacionId, nuevo],
        );
        const resumen = {
          lineas, invalidas, registros: nuevo, anterior: actual, leads_retirados: retirados.rowCount ?? 0,
        };
        await registrarEnBitacora(cliente, {
          usuarioId: yo.id, accion: 'no_llame.importar_padron', entidad: 'no_llame_importaciones',
          entidadId: importacionId, detalle: { archivo: archivo.filename, ...resumen }, ip: req.ip,
        });
        return { id: importacionId, ...resumen };
      });
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      await cliente.query('DROP TABLE IF EXISTS no_llame_padron_carga, no_llame_padron_nuevo').catch(() => {});
      if (importacionId) {
        await cliente
          .query("UPDATE no_llame_importaciones SET estado = 'error', error = $2, terminada_en = now() WHERE id = $1", [
            importacionId,
            (err as Error).message,
          ])
          .catch(() => {});
      }
      throw err;
    } finally {
      await cliente.query("SELECT pg_advisory_unlock(hashtext('no_llame.padron'))").catch(() => {});
      cliente.release();
    }
  });

  // --- Lista propia ---

  app.get('/api/no-llame/propia', { preHandler: requierePermiso(PERMISO) }, async (req) => {
    const f = validar(
      z.object({
        buscar: z.string().regex(/^\d*$/, 'solo dígitos').optional(),
        fuente: z.enum(['manual', 'vendedor', 'ivr']).optional(),
        limite: z.coerce.number().int().min(1).max(500).default(100),
        desde: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const { rows } = await db.query(
      `SELECT n.telefono, n.fuente, n.motivo, n.usuario_id, u.nombre AS usuario_nombre, n.llamada_id, n.creado_en,
              count(*) OVER ()::int AS total
         FROM no_llame_propia n LEFT JOIN usuarios u ON u.id = n.usuario_id
        WHERE ($1::text IS NULL OR n.telefono LIKE '%' || $1 || '%') AND ($2::text IS NULL OR n.fuente = $2)
        ORDER BY n.creado_en DESC LIMIT $3 OFFSET $4`,
      [f.buscar || null, f.fuente ?? null, f.limite, f.desde],
    );
    return { total: rows[0]?.total ?? 0, registros: rows.map(({ total: _t, ...r }) => r) };
  });

  app.post('/api/no-llame/propia', { preHandler: requierePermiso(PERMISO) }, async (req, reply) => {
    const yo = usuarioDe(req);
    const { telefono, motivo } = validar(
      z.object({ telefono: esquemaTelefono, motivo: z.string().trim().max(500).optional() }).strict(),
      req.body,
    );
    const r = await bloquearNumero(db, { telefono, fuente: 'manual', motivo, usuarioId: yo.id });
    await registrarEnBitacora(db, {
      usuarioId: yo.id, accion: 'no_llame.agregar', entidad: 'no_llame_propia', entidadId: telefono, ip: req.ip,
      detalle: { motivo, leads_retirados: r.leadsRetirados },
    });
    return reply.code(r.nuevo ? 201 : 200).send({ telefono, ...r });
  });

  app.delete('/api/no-llame/propia/:telefono', { preHandler: requierePermiso(PERMISO) }, async (req) => {
    const yo = usuarioDe(req);
    const { telefono } = validar(z.object({ telefono: esquemaTelefono }), req.params);
    const { rows } = await db.query('DELETE FROM no_llame_propia WHERE telefono = $1 RETURNING fuente, motivo', [telefono]);
    if (!rows[0]) throw errorHttp(404, 'El número no está en la lista propia');
    await registrarEnBitacora(db, {
      usuarioId: yo.id, accion: 'no_llame.quitar', entidad: 'no_llame_propia', entidadId: telefono, detalle: rows[0], ip: req.ip,
    });
    return { ok: true };
  });

  app.get('/api/no-llame/consultar', { preHandler: requierePermiso(PERMISO, 'campanas.ver') }, async (req) => {
    const { telefono } = validar(z.object({ telefono: esquemaTelefono }), req.query);
    const { rows } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM no_llame_padron WHERE telefono = $1) AS en_padron,
              (SELECT row_to_json(n) FROM (SELECT fuente, motivo, creado_en FROM no_llame_propia WHERE telefono = $1) n) AS en_propia,
              ${sqlBloqueado('$1')} AS bloqueado`,
      [telefono],
    );
    return { telefono, ...rows[0] };
  });
}
