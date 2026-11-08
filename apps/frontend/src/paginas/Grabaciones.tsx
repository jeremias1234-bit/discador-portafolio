// Grabaciones (§11): búsqueda por vendedor, campaña, teléfono, fecha, duración y ventas;
// se escuchan en la página. Descargar pide su propio permiso (queda en la bitácora).
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Encabezado, fechaHora, Interruptor, MensajeError, numero, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import { duracion } from '../utilidades';

interface Grabacion {
  id: number; inicio: string; telefono: string; origen: string; campana: string | null; vendedor: string | null;
  tipificacion: string | null; es_venta: boolean; notas: string | null; duracion_seg: number | null;
}
interface Pagina { total: number; pagina: number; por_pagina: number; grabaciones: Grabacion[] }

export function Grabaciones() {
  const { puede } = useSesion();
  const [params] = useSearchParams();
  const llamadaDirecta = params.get('llamada');
  const [f, setF] = useState({ vendedor_id: '', campana_id: '', telefono: '', desde: '', hasta: '', duracion_min: '', solo_ventas: false });
  const [pagina, setPagina] = useState(1);
  const [sonando, setSonando] = useState<number | null>(llamadaDirecta ? Number(llamadaDirecta) : null);
  const { datos: vendedores } = useDatos<{ id: number; nombre: string }[]>(puede('vendedores.ver', 'usuarios.administrar') ? '/api/usuarios?rol=vendedor&incluir_bajas=true' : null);
  const { datos: campanas } = useDatos<{ id: number; nombre: string }[]>(puede('campanas.ver', 'ivr.ver') ? '/api/campanas?incluir_archivadas=true' : null);
  const { datos: estado } = useDatos<{ grabaciones: number; espacio_libre_gb: number | null; retencion_dias: number }>('/api/grabaciones/estado');

  const ruta = useMemo(() => {
    const q = new URLSearchParams({ pagina: String(pagina) });
    for (const [k, v] of Object.entries(f)) {
      if (k === 'solo_ventas') { if (v) q.set(k, 'true'); }
      else if (v) q.set(k, String(v));
    }
    return `/api/grabaciones?${q}`;
  }, [f, pagina]);
  const { datos, error, cargando } = useDatos<Pagina>(ruta);
  const poner = (k: keyof typeof f, v: string | boolean) => { setF((x) => ({ ...x, [k]: v })); setPagina(1); };
  const paginas = datos ? Math.max(1, Math.ceil(datos.total / datos.por_pagina)) : 1;
  const descarga = puede('grabaciones.descargar');

  return (
    <>
      <Encabezado titulo="Grabaciones">
        {estado && <span className="suave chico">{numero(estado.grabaciones)} guardadas · se borran a los {estado.retencion_dias} días{estado.espacio_libre_gb !== null ? ` · ${estado.espacio_libre_gb} GB libres` : ''}</span>}
      </Encabezado>

      {llamadaDirecta && (
        <section className="tarjeta" style={{ marginBottom: 16 }}>
          <h3>Llamada #{llamadaDirecta}</h3>
          <audio controls autoPlay src={`/api/grabaciones/${llamadaDirecta}/audio`} style={{ width: '100%' }} />
        </section>
      )}

      <div className="fila filtros">
        <input placeholder="Teléfono" value={f.telefono} onChange={(e) => poner('telefono', e.target.value.replace(/\D/g, ''))} style={{ width: 160 }} inputMode="numeric" />
        {vendedores && (
          <select value={f.vendedor_id} onChange={(e) => poner('vendedor_id', e.target.value)} style={{ width: 'auto' }}>
            <option value="">Todos los vendedores</option>
            {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
          </select>
        )}
        {campanas && (
          <select value={f.campana_id} onChange={(e) => poner('campana_id', e.target.value)} style={{ width: 'auto' }}>
            <option value="">Todas las campañas</option>
            {campanas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        )}
        <label className="fila" style={{ gap: 6 }}><span>Desde</span><input type="date" value={f.desde} onChange={(e) => poner('desde', e.target.value)} style={{ width: 'auto' }} /></label>
        <label className="fila" style={{ gap: 6 }}><span>Hasta</span><input type="date" value={f.hasta} onChange={(e) => poner('hasta', e.target.value)} style={{ width: 'auto' }} /></label>
        <label className="fila" style={{ gap: 6 }}><span>Más de</span><input type="number" min={0} value={f.duracion_min} onChange={(e) => poner('duracion_min', e.target.value)} style={{ width: 80 }} /><span>s</span></label>
        <Interruptor etiqueta="Solo ventas" valor={f.solo_ventas} onCambiar={(v) => poner('solo_ventas', v)} />
      </div>

      <MensajeError mensaje={error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead>
            <tr><th>Fecha</th><th>Teléfono</th><th>Vendedor</th><th>Campaña</th><th>Tipificación</th><th className="der">Duración</th><th>Escuchar</th>{descarga && <th></th>}</tr>
          </thead>
          <tbody>
            {(datos?.grabaciones ?? []).map((g) => (
              <tr key={g.id} className={sonando === g.id ? 'resaltado' : ''}>
                <td className="suave" style={{ whiteSpace: 'nowrap' }}>{fechaHora(g.inicio)}</td>
                <td className="numero">{g.telefono}</td>
                <td>{g.vendedor ?? '—'}</td>
                <td>{g.campana ?? (g.origen === 'manual' ? 'Manual' : '—')}</td>
                <td>
                  {g.tipificacion ? <span className={`chip ${g.es_venta ? 'ok' : ''}`}>{g.tipificacion}</span> : <span className="suave">Sin tipificar</span>}
                  {g.notas && <div className="suave chico" title={g.notas} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.notas}</div>}
                </td>
                <td className="der numero">{g.duracion_seg !== null ? duracion(g.duracion_seg) : '—'}</td>
                <td>
                  {sonando === g.id
                    ? <audio controls autoPlay src={`/api/grabaciones/${g.id}/audio`} style={{ height: 32, width: 260 }} onEnded={() => setSonando(null)} />
                    : <button onClick={() => setSonando(g.id)}>▶ Escuchar</button>}
                </td>
                {descarga && <td><a className="boton" href={`/api/grabaciones/${g.id}/audio?descargar=true`} download>Descargar</a></td>}
              </tr>
            ))}
            {!cargando && datos?.grabaciones.length === 0 && <tr><td colSpan={8} className="vacio">No hay grabaciones con esos filtros.</td></tr>}
          </tbody>
        </table>
      </div>
      {datos && paginas > 1 && (
        <div className="fila" style={{ marginTop: 12 }}>
          <button onClick={() => setPagina((p) => p - 1)} disabled={pagina <= 1}>← Anterior</button>
          <span className="suave">Página {pagina} de {paginas} · {numero(datos.total)} grabaciones</span>
          <button onClick={() => setPagina((p) => p + 1)} disabled={pagina >= paginas}>Siguiente →</button>
        </div>
      )}
    </>
  );
}
