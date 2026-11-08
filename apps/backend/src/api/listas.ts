// Bases (listas) y leads: carga de CSV con cruce No Llame y deduplicación, avance y reciclaje (§6).
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse/sync';
import type { FastifyInstance } from 'fastify';
import { from as copyFrom } from 'pg-copy-streams';
import { z } from 'zod';
import { registrarEnBitacora } from '../bitacora.js';
import { valorCopy } from '../db/sql.js';
import { conTransaccion } from '../db/transaccion.js';
import { publicarEvento } from '../eventos.js';
import { sqlBloqueado } from '../noLlame.js';
import { normalizarTelefono } from '../telefonos.js';
import { decodificarTexto, detectarSeparador, leerMultipart } from './archivos.js';
import { requierePermiso, usuarioDe } from './autenticacion.js';
import { buscarCampana } from './campanas.js';
import { errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

const esquemaId = z.object({ id: z.coerce.number().int().positive() });
const MUESTRA_INVALIDOS = 20;

const RESULTADOS_RECICLABLES = [
  'no_contesta', 'ocupado', 'fallida', 'contestador', 'abandonada', 'corto_en_mensaje', 'sin_confirmar',
] as const;

/** Índice de una columna por nombre (sin distinguir mayúsculas) o por número (1 = primera). */
/** Una primera fila cuyo primer campo ya es un teléfono válido: el archivo viene sin encabezados. */
function esFilaDeDatos(fila: string[]): boolean {
  return normalizarTelefono(fila[0] ?? '') !== null;
}

/** Nombres para un archivo sin encabezados, según el formato teléfono | nombre | DNI | resto. */
function encabezadosPorDefecto(ancho: number): string[] {
  return Array.from({ length: ancho }, (_, j) => ['telefono', 'nombre', 'dni'][j] ?? `columna_${j + 1}`);
}

function indiceColumna(encabezados: string[], pedida: string): number {
  const buscada = pedida.trim().toLowerCase();
  const porNombre = encabezados.findIndex((e) => e.trim().toLowerCase() === buscada);
  if (porNombre >= 0) return porNombre;
  const numero = Number(buscada);
  if (Number.isInteger(numero) && numero >= 1 && numero <= encabezados.length) return numero - 1;
  return -1;
}

export function rutasListas(app: FastifyInstance, { db, redis }: Dependencias): void {
  app.get('/api/campanas/:id/listas', { preHandler: requierePermiso('campanas.ver', 'ivr.ver') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    await buscarCampana(db, yo, id);
    const { rows } = await db.query(
      `SELECT li.id, li.nombre, li.archivo_origen, li.activa, li.estado, li.filas_archivo, li.cargados,
              li.descartados_no_llame, li.descartados_duplicados, li.descartados_invalidos,
              li.cargada_por, li.cargada_en, m.*
         FROM listas li
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE l.estado = 'pendiente')::int AS sin_llamar,
                  count(*) FILTER (WHERE l.estado IN ('pendiente', 'reintentar'))::int AS pendientes,
                  count(*) FILTER (WHERE l.estado = 'finalizado')::int AS finalizados,
                  count(*) FILTER (WHERE l.estado = 'agotado')::int AS agotados,
                  count(*) FILTER (WHERE l.estado = 'no_llamar')::int AS no_llamar
             FROM leads l WHERE l.lista_id = li.id) m ON true
        WHERE li.campana_id = $1 ORDER BY li.cargada_en DESC`,
      [id],
    );
    return rows;
  });

  // Carga de un CSV. Formato de referencia: teléfono | nombre | DNI | el resto de las columnas.
  // Campos del formulario (antes del archivo), por nombre o número de columna:
  //   columna_telefono (por defecto la 1), columna_nombre, columna_dni (opcionales), nombre de la base.
  // Si la primera fila ya trae un teléfono válido, el archivo no tiene encabezados.
  app.post('/api/campanas/:id/listas', { preHandler: requierePermiso('campanas.cargar_bases') }, async (req, reply) => {
    const yo = usuarioDe(req);
    const { id: campanaId } = validar(esquemaId, req.params);
    await buscarCampana(db, yo, campanaId);

    const { campos, nombreArchivo, texto } = await leerMultipart(req, async (archivo, campos) => ({
      campos,
      nombreArchivo: archivo.filename,
      texto: decodificarTexto(await archivo.toBuffer()),
    }));
    const opciones = validar(
      z.object({
        columna_telefono: z.string().min(1).default('1'),
        columna_nombre: z.string().optional(),
        columna_dni: z.string().optional(),
        nombre: z.string().trim().max(200).optional(),
      }),
      campos,
    );

    let filas: string[][];
    try {
      filas = parse(texto, {
        delimiter: detectarSeparador(texto),
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (err) {
      throw errorHttp(400, `No se pudo leer el CSV: ${(err as Error).message}`);
    }
    if (filas.length === 0) throw errorHttp(400, 'El archivo está vacío');
    const sinEncabezado = esFilaDeDatos(filas[0]!);
    const ancho = Math.max(...filas.slice(0, 50).map((f) => f.length));
    const encabezados = sinEncabezado ? encabezadosPorDefecto(ancho) : filas[0]!;
    const datos = sinEncabezado ? filas : filas.slice(1);
    if (datos.length === 0) throw errorHttp(400, 'El archivo no tiene filas de datos');

    const iTel = indiceColumna(encabezados, opciones.columna_telefono);
    if (iTel < 0) throw errorHttp(400, `No existe la columna "${opciones.columna_telefono}". Columnas: ${encabezados.join(', ')}`);
    const iNom = opciones.columna_nombre ? indiceColumna(encabezados, opciones.columna_nombre) : -1;
    if (opciones.columna_nombre && iNom < 0) throw errorHttp(400, `No existe la columna "${opciones.columna_nombre}"`);
    const iDni = opciones.columna_dni ? indiceColumna(encabezados, opciones.columna_dni) : -1;
    if (opciones.columna_dni && iDni < 0) throw errorHttp(400, `No existe la columna "${opciones.columna_dni}"`);

    // Normalización: los inválidos se cuentan y se muestran algunos de ejemplo
    const lineas: string[] = [];
    const invalidos: { fila: number; valor: string }[] = [];
    let nInvalidos = 0;
    datos.forEach((fila, i) => {
      const telefono = normalizarTelefono(fila[iTel]);
      if (!telefono) {
        nInvalidos++;
        if (invalidos.length < MUESTRA_INVALIDOS) invalidos.push({ fila: i + 2, valor: fila[iTel] ?? '' });
        return;
      }
      const extra: Record<string, string> = {};
      encabezados.forEach((e, j) => {
        if (j !== iTel && j !== iNom && j !== iDni && fila[j]) extra[e || `columna_${j + 1}`] = fila[j]!;
      });
      const dni = iDni >= 0 ? (fila[iDni] ?? '').replace(/[.\s-]/g, '') || null : null;
      lineas.push([i + 2, telefono, iNom >= 0 ? fila[iNom] || null : null, dni, JSON.stringify(extra)].map((v) =>
        valorCopy(v === null ? null : String(v)),
      ).join('\t') + '\n');
    });

    const resultado = await conTransaccion(db, async (tx) => {
      const { rows: li } = await tx.query<{ id: number }>(
        `INSERT INTO listas (campana_id, nombre, archivo_origen, columnas, cargada_por, filas_archivo)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          campanaId, opciones.nombre || nombreArchivo, nombreArchivo,
          {
            encabezados, sin_encabezado: sinEncabezado, telefono: encabezados[iTel],
            nombre: iNom >= 0 ? encabezados[iNom] : null, dni: iDni >= 0 ? encabezados[iDni] : null,
          },
          yo.id, datos.length,
        ],
      );
      const listaId = li[0]!.id;

      // COPY a una tabla temporal y de ahí a leads: sin No Llame y sin repetidos
      await tx.query('CREATE TEMP TABLE carga_leads (fila INT, telefono TEXT, nombre TEXT, dni TEXT, datos JSONB) ON COMMIT DROP');
      await pipeline(Readable.from(lineas), tx.query(copyFrom('COPY carga_leads FROM STDIN')));
      const { rows } = await tx.query<{ validos: number; no_llame: number; cargados: number }>(
        `WITH unicos AS (
           SELECT DISTINCT ON (telefono) telefono, nombre, dni, datos FROM carga_leads ORDER BY telefono, fila
         ), bloqueados AS (
           SELECT u.telefono FROM unicos u WHERE ${sqlBloqueado('u.telefono')}
         ), insertados AS (
           INSERT INTO leads (lista_id, campana_id, telefono, nombre, dni, datos)
           SELECT $1, $2, u.telefono, u.nombre, u.dni, u.datos FROM unicos u
            WHERE NOT EXISTS (SELECT 1 FROM bloqueados b WHERE b.telefono = u.telefono)
           ON CONFLICT (campana_id, telefono) DO NOTHING
           RETURNING 1
         )
         SELECT (SELECT count(*) FROM carga_leads)::int AS validos,
                (SELECT count(*) FROM carga_leads c WHERE c.telefono IN (SELECT telefono FROM bloqueados))::int AS no_llame,
                (SELECT count(*) FROM insertados)::int AS cargados`,
        [listaId, campanaId],
      );
      const r = rows[0]!;
      const conteo = {
        filas_archivo: datos.length,
        cargados: r.cargados,
        descartados_no_llame: r.no_llame,
        descartados_duplicados: r.validos - r.no_llame - r.cargados,
        descartados_invalidos: nInvalidos,
      };
      await tx.query(
        `UPDATE listas SET estado = 'lista', cargados = $2, descartados_no_llame = $3,
                descartados_duplicados = $4, descartados_invalidos = $5 WHERE id = $1`,
        [listaId, conteo.cargados, conteo.descartados_no_llame, conteo.descartados_duplicados, conteo.descartados_invalidos],
      );
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: 'lista.cargar', entidad: 'listas', entidadId: listaId, ip: req.ip,
        detalle: { campana_id: campanaId, archivo: nombreArchivo, ...conteo },
      });
      return { id: listaId, ...conteo, ejemplos_invalidos: invalidos };
    });

    await publicarEvento(redis, 'campana.leads', { id: campanaId });
    return reply.code(201).send(resultado);
  });

  app.patch('/api/listas/:id', { preHandler: requierePermiso('campanas.cargar_bases') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const cambios = validar(
      z.object({ nombre: z.string().trim().min(1).max(200), activa: z.boolean() }).partial().strict()
        .refine((d) => Object.keys(d).length > 0, 'no hay campos para modificar'),
      req.body,
    );
    const { rows } = await db.query<{ campana_id: number }>(
      `UPDATE listas SET nombre = COALESCE($2, nombre), activa = COALESCE($3, activa) WHERE id = $1
       RETURNING campana_id`,
      [id, cambios.nombre ?? null, cambios.activa ?? null],
    );
    if (!rows[0]) throw errorHttp(404, 'Lista no encontrada');
    await registrarEnBitacora(db, {
      usuarioId: yo.id, accion: 'lista.editar', entidad: 'listas', entidadId: id, detalle: cambios, ip: req.ip,
    });
    await publicarEvento(redis, 'campana.leads', { id: rows[0].campana_id });
    return { ok: true };
  });

  // Borrar solo si ningún lead se llamó todavía; si no, desactivarla
  app.delete('/api/listas/:id', { preHandler: requierePermiso('campanas.cargar_bases') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const campanaId = await conTransaccion(db, async (tx) => {
      const { rows } = await tx.query<{ campana_id: number; llamados: number }>(
        `SELECT li.campana_id,
                (SELECT count(*)::int FROM leads l WHERE l.lista_id = li.id AND l.intentos > 0) AS llamados
           FROM listas li WHERE li.id = $1 FOR UPDATE`,
        [id],
      );
      const lista = rows[0];
      if (!lista) throw errorHttp(404, 'Lista no encontrada');
      if (lista.llamados > 0) {
        throw errorHttp(409, `La lista ya tiene ${lista.llamados} contactos llamados: desactivala en lugar de borrarla`);
      }
      await tx.query('DELETE FROM listas WHERE id = $1', [id]);
      await registrarEnBitacora(tx, { usuarioId: yo.id, accion: 'lista.borrar', entidad: 'listas', entidadId: id, ip: req.ip });
      return lista.campana_id;
    });
    await publicarEvento(redis, 'campana.leads', { id: campanaId });
    return { ok: true };
  });

  // Reciclaje (estilo VICIdial): vuelve a la cola los leads cuyo último resultado está en la lista
  app.post('/api/listas/:id/reciclar', { preHandler: requierePermiso('campanas.reciclar_bases') }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const { resultados, reiniciar_intentos } = validar(
      z.object({
        resultados: z.array(z.enum(RESULTADOS_RECICLABLES)).min(1),
        reiniciar_intentos: z.boolean().default(true),
      }).strict(),
      req.body,
    );
    const { rows, rowCount } = await db.query<{ campana_id: number }>(
      `UPDATE leads SET estado = 'reintentar', proximo_intento = now(),
              intentos = CASE WHEN $3 THEN 0 ELSE intentos END
        WHERE lista_id = $1 AND estado IN ('agotado', 'reintentar') AND ultimo_resultado = ANY($2)
          AND NOT ${sqlBloqueado('leads.telefono')}
        RETURNING campana_id`,
      [id, resultados, reiniciar_intentos],
    );
    await registrarEnBitacora(db, {
      usuarioId: yo.id, accion: 'lista.reciclar', entidad: 'listas', entidadId: id, ip: req.ip,
      detalle: { resultados, reiniciar_intentos, reciclados: rowCount },
    });
    if (rows[0]) await publicarEvento(redis, 'campana.leads', { id: rows[0].campana_id });
    return { reciclados: rowCount ?? 0 };
  });
}
