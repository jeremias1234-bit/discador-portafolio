// Editor genérico de catálogos (gateways, tipificaciones, descansos, sedes, feriados):
// tabla + alta/edición en un modal + borrado. Los campos se describen con una lista.
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { Campo, Interruptor, MensajeError, Modal, useAccion, useDatos } from './ui';

export interface DefCampo<T> {
  clave: keyof T & string;
  etiqueta: string;
  tipo: 'texto' | 'numero' | 'si_no' | 'opciones' | 'hora' | 'fecha';
  ayuda?: string;
  /** Acepta vacío (se guarda null). */
  nulo?: boolean;
  requerido?: boolean;
  opciones?: [string | number, string][];
  min?: number;
  max?: number;
  paso?: number;
  porDefecto?: unknown;
  /** Solo se muestra si devuelve true (según el resto del formulario). */
  visible?: (f: Partial<T>) => boolean;
  /** Valor que se guarda cuando el campo queda oculto (si no, null para los que admiten vacío). */
  siOculto?: unknown;
  /** Cómo se ve en la tabla; si falta, el valor tal cual. */
  mostrar?: (fila: T) => ReactNode;
  enTabla?: boolean;
}

export function Catalogo<T extends { id: number }>({
  ruta, campos, editable, singular, columnaActivo, nota, incluirInactivos = true,
}: {
  ruta: string;
  campos: DefCampo<T>[];
  editable: boolean;
  singular: string;
  columnaActivo?: keyof T & string;
  nota?: ReactNode;
  incluirInactivos?: boolean;
}) {
  const { datos, error, recargar } = useDatos<T[]>(`${ruta}${incluirInactivos ? '?incluir_inactivos=true' : ''}`);
  const [editando, setEditando] = useState<T | 'nuevo' | null>(null);
  const accion = useAccion();
  const columnas = campos.filter((c) => c.enTabla !== false);

  const borrar = async (fila: T) => {
    if (!confirm(`¿Borrar este ${singular}? Si está en uso, queda desactivado.`)) return;
    if (await accion.ejecutar(() => api.borrar(`${ruta}/${fila.id}`))) void recargar();
  };

  return (
    <div className="pila" style={{ gap: 12 }}>
      {nota}
      {editable && <div><button className="primario" onClick={() => setEditando('nuevo')}>Agregar {singular}</button></div>}
      <MensajeError mensaje={error ?? accion.error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead>
            <tr>
              {columnas.map((c) => <th key={c.clave}>{c.etiqueta}</th>)}
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {(datos ?? []).map((fila) => (
              <tr key={fila.id} className={`${editable ? 'clic' : ''} ${columnaActivo && !fila[columnaActivo] ? 'inactivo' : ''}`}
                onClick={() => editable && setEditando(fila)}>
                {columnas.map((c) => <td key={c.clave}>{c.mostrar ? c.mostrar(fila) : valorLegible(fila[c.clave], c)}</td>)}
                {editable && (
                  <td className="der">
                    <button onClick={(e) => { e.stopPropagation(); void borrar(fila); }} disabled={accion.ocupado} aria-label="Borrar" title="Borrar">✕</button>
                  </td>
                )}
              </tr>
            ))}
            {datos?.length === 0 && <tr><td colSpan={columnas.length + 1} className="vacio">Todavía no hay registros.</td></tr>}
          </tbody>
        </table>
      </div>
      {editando && (
        <FormularioCatalogo
          ruta={ruta} campos={campos} singular={singular}
          fila={editando === 'nuevo' ? null : editando}
          onCerrar={() => setEditando(null)}
          onGuardado={() => { setEditando(null); void recargar(); }}
        />
      )}
    </div>
  );
}

function valorLegible<T>(v: unknown, c: DefCampo<T>): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="suave">—</span>;
  if (c.tipo === 'si_no') return v ? 'Sí' : 'No';
  if (c.tipo === 'opciones') return c.opciones?.find(([k]) => k === v)?.[1] ?? String(v);
  return String(v);
}

function FormularioCatalogo<T extends { id: number }>({ ruta, campos, singular, fila, onCerrar, onGuardado }: {
  ruta: string; campos: DefCampo<T>[]; singular: string; fila: T | null; onCerrar: () => void; onGuardado: () => void;
}) {
  const [f, setF] = useState<Partial<T>>(() =>
    Object.fromEntries(campos.map((c) => [c.clave, fila ? fila[c.clave] : (c.porDefecto ?? (c.tipo === 'si_no' ? false : c.nulo ? null : ''))])) as Partial<T>,
  );
  const { ocupado, error, ejecutar } = useAccion();
  const poner = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    // Solo se mandan los campos visibles; los ocultos van en null si admiten vacío
    const cuerpo: Record<string, unknown> = {};
    for (const c of campos) {
      const visible = !c.visible || c.visible(f);
      let v = (f as Record<string, unknown>)[c.clave];
      if (!visible) {
        const oculto = c.siOculto !== undefined ? c.siOculto : c.nulo ? null : undefined;
        if (oculto !== undefined && (!fila || JSON.stringify(fila[c.clave]) !== JSON.stringify(oculto))) cuerpo[c.clave] = oculto;
        continue;
      }
      if (v === '' && c.nulo) v = null;
      if (fila && JSON.stringify(v) === JSON.stringify(fila[c.clave])) continue;
      if (!fila && (v === '' || v === null) && !c.requerido) continue;
      cuerpo[c.clave] = v;
    }
    if (fila && Object.keys(cuerpo).length === 0) return onCerrar();
    if (await ejecutar(() => (fila ? api.patch(`${ruta}/${fila.id}`, cuerpo) : api.post(ruta, cuerpo)))) onGuardado();
  };

  return (
    <Modal titulo={fila ? `Editar ${singular}` : `Agregar ${singular}`} onCerrar={onCerrar}>
      <form className="pila" onSubmit={guardar} style={{ gap: 14 }}>
        <div className="rejilla">
          {campos.filter((c) => c.tipo !== 'si_no' && (!c.visible || c.visible(f))).map((c) => {
            const v = (f as Record<string, unknown>)[c.clave];
            return (
              <Campo key={c.clave} etiqueta={c.etiqueta} ayuda={c.ayuda}>
                {c.tipo === 'opciones' ? (
                  <select value={v === null || v === undefined ? '' : String(v)} required={c.requerido}
                    onChange={(e) => {
                      const o = c.opciones?.find(([k]) => String(k) === e.target.value);
                      poner(c.clave, o ? o[0] : null);
                    }}>
                    {c.nulo && <option value="">—</option>}
                    {c.opciones?.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                  </select>
                ) : (
                  <input
                    type={c.tipo === 'numero' ? 'number' : c.tipo === 'hora' ? 'time' : c.tipo === 'fecha' ? 'date' : 'text'}
                    value={v === null || v === undefined ? '' : String(v)}
                    min={c.min} max={c.max} step={c.paso} required={c.requerido}
                    onChange={(e) => poner(c.clave, c.tipo === 'numero' ? (e.target.value === '' ? (c.nulo ? null : '') : Number(e.target.value)) : e.target.value)}
                  />
                )}
              </Campo>
            );
          })}
        </div>
        {campos.filter((c) => c.tipo === 'si_no' && (!c.visible || c.visible(f))).map((c) => (
          <Interruptor key={c.clave} etiqueta={c.etiqueta} ayuda={c.ayuda} valor={!!(f as Record<string, unknown>)[c.clave]} onCambiar={(v) => poner(c.clave, v)} />
        ))}
        <MensajeError mensaje={error} />
        <div><button className="primario" disabled={ocupado}>{fila ? 'Guardar' : 'Agregar'}</button></div>
      </form>
    </Modal>
  );
}
