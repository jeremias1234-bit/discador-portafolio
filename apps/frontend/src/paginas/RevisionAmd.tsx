// Revisión del AMD: escuchar los segundos de la detección y marcar si acertó.
// Así se sabe cuántas personas se cortaron por "contestador" y cuántas máquinas pasaron.
import { useMemo, useState } from 'react';
import { api } from '../api';
import { Encabezado, fechaHora, MensajeError, numero, useDatos } from '../componentes/ui';

type Estado = 'MACHINE' | 'NOTSURE' | 'HUMAN' | 'HANGUP';
interface Resumen { amd_estado: Estado; llamadas: number; revisadas: number; errores: number; contestador_segun_vendedor: number; con_audio: number }
interface Fila {
  id: number; inicio: string; telefono: string; campana: string | null; amd_estado: Estado; amd_causa: string | null;
  resultado: string | null; tipificacion: string | null; contestador_segun_vendedor: boolean;
  amd_revision: 'acerto' | 'error' | null; revisado_por: string | null; tiene_audio: boolean;
}
interface Pagina { total: number; pagina: number; por_pagina: number; llamadas: Fila[] }

const NOMBRE: Record<Estado, string> = { MACHINE: 'Contestador', HUMAN: 'Persona', NOTSURE: 'Dudosa', HANGUP: 'Cortó durante la detección' };
// Qué significa acertar o equivocarse según lo que dijo el AMD
const BOTONES: Record<Estado, [string, string]> = {
  MACHINE: ['Era contestador', 'Era una persona'],
  HUMAN: ['Era una persona', 'Era contestador'],
  NOTSURE: ['Era una persona', 'Era contestador'],
  HANGUP: ['Bien', 'Mal'],
};
const hoy = () => new Date().toLocaleDateString('sv-SE');

export function RevisionAmd() {
  const [desde, setDesde] = useState(hoy());
  const [hasta, setHasta] = useState(hoy());
  const [estado, setEstado] = useState<Estado | ''>('MACHINE');
  const [revision, setRevision] = useState<'pendiente' | 'acerto' | 'error' | ''>('pendiente');
  const [pagina, setPagina] = useState(1);
  const [sonando, setSonando] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filtro = useMemo(() => new URLSearchParams({ desde, hasta: hasta < desde ? desde : hasta }).toString(), [desde, hasta]);
  const { datos: resumen, recargar: recargarResumen } = useDatos<Resumen[]>(`/api/amd/resumen?${filtro}`);
  const ruta = useMemo(() => {
    const q = new URLSearchParams(filtro);
    if (estado) q.set('estado', estado);
    if (revision) q.set('revision', revision);
    q.set('pagina', String(pagina));
    return `/api/amd/revision?${q}`;
  }, [filtro, estado, revision, pagina]);
  const { datos, error: errorLista, setDatos } = useDatos<Pagina>(ruta);
  const paginas = datos ? Math.max(1, Math.ceil(datos.total / datos.por_pagina)) : 1;

  const marcar = async (f: Fila, veredicto: 'acerto' | 'error' | null) => {
    setError(null);
    try {
      await api.post(`/api/amd/${f.id}/revision`, { veredicto });
      // Se actualiza en el lugar: la fila queda visible hasta cambiar de filtro
      setDatos((d) => d && { ...d, llamadas: d.llamadas.map((x) => (x.id === f.id ? { ...x, amd_revision: veredicto } : x)) });
      void recargarResumen();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const total = (resumen ?? []).reduce((t, r) => t + r.llamadas, 0);
  const maquinas = resumen?.find((r) => r.amd_estado === 'MACHINE');
  const pasaron = (resumen ?? []).filter((r) => r.amd_estado !== 'MACHINE').reduce((t, r) => t + r.contestador_segun_vendedor, 0);

  return (
    <>
      <Encabezado titulo="Revisión de AMD" />
      <p className="suave" style={{ marginTop: -8 }}>
        Escuchá los segundos que analizó el detector y marcá si acertó. Con unas decenas revisadas ya se ve si está cortando personas
        (conviene bajar la exigencia) o si deja pasar contestadores (conviene subirla). Los parámetros se ajustan en Configuración → AMD.
      </p>
      <div className="fila filtros">
        <label className="fila" style={{ gap: 6 }}><span>Desde</span><input type="date" value={desde} onChange={(e) => { setDesde(e.target.value); setPagina(1); }} style={{ width: 'auto' }} /></label>
        <label className="fila" style={{ gap: 6 }}><span>Hasta</span><input type="date" value={hasta} onChange={(e) => { setHasta(e.target.value); setPagina(1); }} style={{ width: 'auto' }} /></label>
      </div>

      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi"><strong className="numero">{numero(total)}</strong><span>Atendidas con AMD</span></div>
        <div className="kpi"><strong className="numero">{numero(maquinas?.llamadas ?? 0)}</strong><span>Cortadas por contestador</span></div>
        <div className={`kpi ${maquinas && maquinas.errores ? 'malo' : ''}`}>
          <strong className="numero">{maquinas && maquinas.revisadas ? `${Math.round((100 * maquinas.errores) / maquinas.revisadas)}%` : '—'}</strong>
          <span>Personas cortadas por error ({maquinas?.errores ?? 0} de {maquinas?.revisadas ?? 0} revisadas)</span>
        </div>
        <div className={`kpi ${pasaron ? 'atencion' : ''}`}><strong className="numero">{numero(pasaron)}</strong><span>Contestadores que llegaron al vendedor</span></div>
      </div>

      <div className="tabla-envoltura" style={{ marginBottom: 16 }}>
        <table className="tabla compacta">
          <thead><tr><th>El AMD dijo</th><th className="der">Llamadas</th><th className="der">Revisadas</th><th className="der">Se equivocó</th><th className="der">Con audio</th></tr></thead>
          <tbody>
            {(resumen ?? []).map((r) => (
              <tr key={r.amd_estado}>
                <td>{NOMBRE[r.amd_estado] ?? r.amd_estado}</td>
                <td className="der numero">{numero(r.llamadas)}</td>
                <td className="der numero">{numero(r.revisadas)}</td>
                <td className="der numero">{numero(r.errores)}</td>
                <td className="der numero">{numero(r.con_audio)}</td>
              </tr>
            ))}
            {resumen?.length === 0 && <tr><td colSpan={5} className="vacio">Sin llamadas con AMD en el período.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="fila filtros">
        <select value={estado} onChange={(e) => { setEstado(e.target.value as Estado | ''); setPagina(1); }} style={{ width: 'auto' }}>
          <option value="">Todo lo que dijo el AMD</option>
          {(Object.keys(NOMBRE) as Estado[]).map((k) => <option key={k} value={k}>{NOMBRE[k]}</option>)}
        </select>
        <select value={revision} onChange={(e) => { setRevision(e.target.value as typeof revision); setPagina(1); }} style={{ width: 'auto' }}>
          <option value="pendiente">Sin revisar</option>
          <option value="error">Se equivocó</option>
          <option value="acerto">Acertó</option>
          <option value="">Todas</option>
        </select>
        {datos && <span className="suave">{numero(datos.total)} llamadas</span>}
      </div>
      <MensajeError mensaje={error ?? errorLista} />
      <div className="tabla-envoltura">
        <table className="tabla compacta">
          <thead><tr><th>Fecha</th><th>Teléfono</th><th>Campaña</th><th>El AMD dijo</th><th>Después</th><th>Escuchar</th><th>¿Acertó?</th></tr></thead>
          <tbody>
            {(datos?.llamadas ?? []).map((f) => {
              const [si, no] = BOTONES[f.amd_estado] ?? ['Acertó', 'Se equivocó'];
              return (
                <tr key={f.id} className={sonando === f.id ? 'resaltado' : ''}>
                  <td className="suave" style={{ whiteSpace: 'nowrap' }}>{fechaHora(f.inicio)}</td>
                  <td className="numero">{f.telefono}</td>
                  <td>{f.campana ?? '—'}</td>
                  <td>{NOMBRE[f.amd_estado] ?? f.amd_estado}<div className="suave chico">{f.amd_causa?.split('-')[0] ?? ''}</div></td>
                  <td>
                    {f.tipificacion ?? (f.resultado ? f.resultado.replace(/_/g, ' ') : '—')}
                    {f.contestador_segun_vendedor && <div className="chip aviso">el vendedor dijo contestador</div>}
                  </td>
                  <td>
                    {!f.tiene_audio ? <span className="suave chico">Sin audio</span>
                      : sonando === f.id
                        ? <audio controls autoPlay src={`/api/amd/${f.id}/audio`} style={{ height: 32, width: 220 }} />
                        : <button className="chico" onClick={() => setSonando(f.id)}>▶ Escuchar</button>}
                  </td>
                  <td>
                    <div className="fila" style={{ flexWrap: 'nowrap', gap: 4 }}>
                      <button className={`chico ${f.amd_revision === 'acerto' ? 'seleccionado' : ''}`} onClick={() => void marcar(f, f.amd_revision === 'acerto' ? null : 'acerto')}>✓ {si}</button>
                      <button className={`chico ${f.amd_revision === 'error' ? 'seleccionado' : ''}`} onClick={() => void marcar(f, f.amd_revision === 'error' ? null : 'error')}>✗ {no}</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {datos?.llamadas.length === 0 && <tr><td colSpan={7} className="vacio">No hay llamadas con ese filtro.</td></tr>}
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
