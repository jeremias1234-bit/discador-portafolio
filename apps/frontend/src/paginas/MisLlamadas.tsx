// Historial del vendedor: sus llamadas con resultado, tipificación y notas, y sus grabaciones.
import { useMemo, useState } from 'react';
import { Encabezado, fechaHora, MensajeError, numero, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import { duracion } from '../utilidades';

interface LlamadaPropia {
  id: number; inicio: string; telefono: string; origen: string; campana: string | null; lead_nombre: string | null;
  dni: string | null; resultado: string | null; tipificacion: string | null; es_venta: boolean; notas: string | null;
  duracion_seg: number | null; tiene_grabacion: boolean;
}
interface Pagina { total: number; pagina: number; por_pagina: number; llamadas: LlamadaPropia[] }

const hoy = () => new Date().toLocaleDateString('sv-SE');

export function MisLlamadas() {
  const { puede } = useSesion();
  const [desde, setDesde] = useState(hoy());
  const [hasta, setHasta] = useState(hoy());
  const [telefono, setTelefono] = useState('');
  const [pagina, setPagina] = useState(1);
  const [sonando, setSonando] = useState<number | null>(null);
  const ruta = useMemo(() => {
    const q = new URLSearchParams({ pagina: String(pagina) });
    if (desde) q.set('desde', desde);
    if (hasta) q.set('hasta', hasta);
    if (telefono) q.set('telefono', telefono);
    return `/api/puesto/historial?${q}`;
  }, [desde, hasta, telefono, pagina]);
  const { datos, error, cargando } = useDatos<Pagina>(ruta);
  const escucha = puede('grabaciones.propias');
  const paginas = datos ? Math.max(1, Math.ceil(datos.total / datos.por_pagina)) : 1;
  const ventas = (datos?.llamadas ?? []).filter((l) => l.es_venta).length;

  return (
    <>
      <Encabezado titulo="Mis llamadas">
        {datos && <span className="suave">{numero(datos.total)} llamadas{pagina === 1 && ventas ? ` · ${ventas} ventas en esta página` : ''}</span>}
      </Encabezado>
      <div className="fila filtros">
        <label className="fila" style={{ gap: 6 }}><span>Desde</span><input type="date" value={desde} onChange={(e) => { setDesde(e.target.value); setPagina(1); }} style={{ width: 'auto' }} /></label>
        <label className="fila" style={{ gap: 6 }}><span>Hasta</span><input type="date" value={hasta} onChange={(e) => { setHasta(e.target.value); setPagina(1); }} style={{ width: 'auto' }} /></label>
        <button onClick={() => { setDesde(hoy()); setHasta(hoy()); setPagina(1); }}>Hoy</button>
        <button onClick={() => { setDesde(''); setHasta(''); setPagina(1); }}>Todas</button>
        <input placeholder="Buscar teléfono" value={telefono} inputMode="numeric" style={{ width: 180 }}
          onChange={(e) => { setTelefono(e.target.value.replace(/\D/g, '')); setPagina(1); }} />
      </div>
      <MensajeError mensaje={error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead>
            <tr><th>Fecha</th><th>Número</th><th>Nombre</th><th>DNI</th><th>Campaña</th><th>Tipificación</th><th className="der">Duración</th>{escucha && <th>Grabación</th>}</tr>
          </thead>
          <tbody>
            {(datos?.llamadas ?? []).map((l) => (
              <tr key={l.id} className={sonando === l.id ? 'resaltado' : ''}>
                <td className="suave" style={{ whiteSpace: 'nowrap' }}>{fechaHora(l.inicio)}</td>
                <td className="numero">{l.telefono}</td>
                <td>{l.lead_nombre ?? '—'}</td>
                <td className="numero">{l.dni ?? '—'}</td>
                <td>{l.campana ?? (l.origen === 'manual' ? 'Manual' : '—')}</td>
                <td>
                  {l.tipificacion ? <span className={`chip ${l.es_venta ? 'ok' : ''}`}>{l.tipificacion}</span> : <span className="chip aviso">Sin tipificar</span>}
                  {l.notas && <div className="suave chico" title={l.notas} style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.notas}</div>}
                </td>
                <td className="der numero">{l.duracion_seg !== null ? duracion(l.duracion_seg) : '—'}</td>
                {escucha && (
                  <td>
                    {!l.tiene_grabacion ? <span className="suave chico">Sin grabación</span>
                      : sonando === l.id
                        ? <audio controls autoPlay src={`/api/puesto/llamadas/${l.id}/audio`} style={{ height: 32, width: 240 }} onEnded={() => setSonando(null)} />
                        : <button onClick={() => setSonando(l.id)}>▶ Escuchar</button>}
                  </td>
                )}
              </tr>
            ))}
            {!cargando && datos?.llamadas.length === 0 && <tr><td colSpan={8} className="vacio">No hay llamadas en ese período.</td></tr>}
          </tbody>
        </table>
      </div>
      {datos && paginas > 1 && (
        <div className="fila" style={{ marginTop: 12 }}>
          <button onClick={() => setPagina((p) => p - 1)} disabled={pagina <= 1}>← Anterior</button>
          <span className="suave">Página {pagina} de {paginas}</span>
          <button onClick={() => setPagina((p) => p + 1)} disabled={pagina >= paginas}>Siguiente →</button>
        </div>
      )}
    </>
  );
}
