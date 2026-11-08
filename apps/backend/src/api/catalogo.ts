// Fábrica de ABM para tablas de catálogo (gateways, tipificaciones, descansos, sedes, bloqueos).
// DELETE borra si nadie lo usa; si está referenciado y la tabla tiene columna de activo, lo desactiva.
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { registrarEnBitacora } from '../bitacora.js';
import { armarUpdate } from '../db/sql.js';
import { conTransaccion } from '../db/transaccion.js';
import { publicarEvento } from '../eventos.js';
import { usuarioDe, type UsuarioSesion } from './autenticacion.js';
import { codigoPg, errorHttp, validar } from './errores.js';
import type { Dependencias } from './servidor.js';

export interface DefinicionCatalogo {
  ruta: string; // ej. '/api/tipificaciones'
  tabla: string;
  entidad: string; // para la bitácora: 'tipificacion' -> 'tipificacion.crear'
  columnas: string; // lista del SELECT
  orden: string;
  campos: z.ZodRawShape; // campos editables
  requeridos: string[]; // obligatorios en el alta
  columnaActivo?: string; // 'activo' / 'activa' si admite baja lógica
  ver: preHandlerAsyncHookHandler;
  editar: preHandlerAsyncHookHandler;
  evento?: string; // se publica al cambiar algo
  /** Validación extra con el registro completo resultante (antes de guardar). */
  validarRegistro?: (registro: Record<string, unknown>) => void;
  /** Columnas que se completan solas en el alta (ej. creado_por). */
  extrasAlta?: (yo: UsuarioSesion) => Record<string, unknown>;
}

const esquemaId = z.object({ id: z.coerce.number().int().positive() });

export function rutasCatalogo(app: FastifyInstance, { db, redis }: Dependencias, def: DefinicionCatalogo): void {
  const alta = z
    .object(def.campos)
    .partial()
    .required(Object.fromEntries(def.requeridos.map((c) => [c, true])) as never)
    .strict();
  const edicion = z
    .object(def.campos)
    .partial()
    .strict()
    .refine((d) => Object.keys(d).length > 0, 'no hay campos para modificar');
  const seleccionar = `SELECT ${def.columnas} FROM ${def.tabla}`;
  const avisar = async (id: number) => {
    if (def.evento) await publicarEvento(redis, def.evento, { id });
  };

  app.get(def.ruta, { preHandler: def.ver }, async (req) => {
    const { incluir_inactivos } = validar(z.object({ incluir_inactivos: z.enum(['true', 'false']).optional() }), req.query);
    const filtro = def.columnaActivo && incluir_inactivos !== 'true' ? `WHERE ${def.columnaActivo}` : '';
    const { rows } = await db.query(`${seleccionar} ${filtro} ORDER BY ${def.orden}`);
    return rows;
  });

  app.post(def.ruta, { preHandler: def.editar }, async (req, reply) => {
    const yo = usuarioDe(req);
    const datos = validar(alta, req.body) as Record<string, unknown>;
    def.validarRegistro?.(datos);
    const fila = { ...datos, ...def.extrasAlta?.(yo) };
    const columnas = Object.keys(fila);
    const creado = await conTransaccion(db, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO ${def.tabla} (${columnas.join(', ')}) VALUES (${columnas.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING id`,
        Object.values(fila),
      );
      const id = rows[0].id as number;
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: `${def.entidad}.crear`, entidad: def.tabla, entidadId: id, detalle: datos, ip: req.ip,
      });
      return (await tx.query(`${seleccionar} WHERE id = $1`, [id])).rows[0];
    });
    await avisar(creado.id);
    return reply.code(201).send(creado);
  });

  app.patch(`${def.ruta}/:id`, { preHandler: def.editar }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    const cambios = validar(edicion, req.body) as Record<string, unknown>;
    const actualizado = await conTransaccion(db, async (tx) => {
      const { rows: antes } = await tx.query(`SELECT * FROM ${def.tabla} WHERE id = $1 FOR UPDATE`, [id]);
      if (!antes[0]) throw errorHttp(404, 'No encontrado');
      def.validarRegistro?.({ ...antes[0], ...cambios });
      const { asignaciones, valores } = armarUpdate(cambios);
      await tx.query(`UPDATE ${def.tabla} SET ${asignaciones} WHERE id = $1`, [id, ...valores]);
      await registrarEnBitacora(tx, {
        usuarioId: yo.id, accion: `${def.entidad}.editar`, entidad: def.tabla, entidadId: id, ip: req.ip,
        detalle: { antes: Object.fromEntries(Object.keys(cambios).map((c) => [c, antes[0][c]])), despues: cambios },
      });
      return (await tx.query(`${seleccionar} WHERE id = $1`, [id])).rows[0];
    });
    await avisar(id);
    return actualizado;
  });

  app.delete(`${def.ruta}/:id`, { preHandler: def.editar }, async (req) => {
    const yo = usuarioDe(req);
    const { id } = validar(esquemaId, req.params);
    let resultado: { borrado: boolean; desactivado: boolean };
    try {
      resultado = await conTransaccion(db, async (tx) => {
        const { rowCount } = await tx.query(`DELETE FROM ${def.tabla} WHERE id = $1`, [id]);
        if (!rowCount) throw errorHttp(404, 'No encontrado');
        await registrarEnBitacora(tx, { usuarioId: yo.id, accion: `${def.entidad}.borrar`, entidad: def.tabla, entidadId: id, ip: req.ip });
        return { borrado: true, desactivado: false };
      });
    } catch (err) {
      if (codigoPg(err) !== '23503') throw err;
      if (!def.columnaActivo) throw errorHttp(409, 'Está en uso: no se puede borrar');
      // En uso: se desactiva para conservar la historia
      await db.query(`UPDATE ${def.tabla} SET ${def.columnaActivo} = false WHERE id = $1`, [id]);
      await registrarEnBitacora(db, { usuarioId: yo.id, accion: `${def.entidad}.desactivar`, entidad: def.tabla, entidadId: id, ip: req.ip });
      resultado = { borrado: false, desactivado: true };
    }
    await avisar(id);
    return resultado;
  });
}
