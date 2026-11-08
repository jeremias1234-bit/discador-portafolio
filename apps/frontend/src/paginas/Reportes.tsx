// Reportes (§12): embudo, por hora, por vendedor (con la espera entre llamadas), por campaña, por base,
// contactabilidad, AMD, descansos y detalle de llamadas. Todos con filtro de fechas y exportación a CSV.
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Encabezado, MensajeError, numero, Pestanas, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import { duracion } from '../utilidades';

type Fila = Record<string, unknown>;
interface Columna { clave: string; titulo: string; tipo?: 'numero' | 'pct' | 'seg' | 'texto' | 'si_no'; ayuda?: string }

type Pestana = 'resumen' | 'horas' | 'vendedores' | 'campanas' | 'listas' | 'resultados' | 'amd' | 'descansos' | 'llamadas';
const PESTANAS: [Pestana, string][] = [
  ['resumen', 'Resumen'], ['horas', 'Por hora'], ['vendedores', 'Vendedores'], ['campanas', 'Campañas'], ['listas', 'Bases'],
  ['resultados', 'Contactabilidad'], ['amd', 'AMD'], ['descansos', 'Descansos'], ['llamadas', 'Llamadas'],
];

const METRICAS: Columna[] = [
  { clave: 'intentos', titulo: 'Intentos', tipo: 'numero' },
  { clave: 'atendidas', titulo: 'Atendieron', tipo: 'numero' },
  { clave: 'personas', titulo: 'Personas', tipo: 'numero', ayuda: 'Atendieron y no era contestador' },
  { clave: 'contactabilidad_pct', titulo: 'Contactab.', tipo: 'pct' },
  { clave: 'llegaron_al_vendedor', titulo: 'Al vendedor', tipo: 'numero' },
  { clave: 'abandonos', titulo: 'Abandonos', tipo: 'numero' },
  { clave: 'abandono_pct', titulo: 'Abandono', tipo: 'pct' },
  { clave: 'ventas', titulo: 'Ventas', tipo: 'numero' },
  { clave: 'conversacion_promedio_seg', titulo: 'Conversación prom.', tipo: 'seg' },
];

const COLUMNAS: Record<Exclude<Pestana, 'resumen'>, Columna[]> = {
  horas: [{ clave: 'hora', titulo: 'Hora' }, ...METRICAS],
  vendedores: [
    { clave: 'nombre', titulo: 'Vendedor', tipo: 'texto' }, { clave: 'atendidas', titulo: 'Atendidas', tipo: 'numero' },
    { clave: 'ventas', titulo: 'Ventas', tipo: 'numero' }, { clave: 'conversion_pct', titulo: 'Conversión', tipo: 'pct' },
    { clave: 'manuales', titulo: 'Manuales', tipo: 'numero' }, { clave: 'tipificadas', titulo: 'Tipificadas', tipo: 'numero' },
    { clave: 'conversacion_promedio_seg', titulo: 'Conversación prom.', tipo: 'seg' },
    { clave: 'espera_entre_llamadas_seg', titulo: 'Espera entre llamadas', tipo: 'seg', ayuda: 'Tiempo disponible promedio entre una llamada y la siguiente' },
    { clave: 'seg_disponible', titulo: 'Disponible', tipo: 'seg' }, { clave: 'seg_en_llamada', titulo: 'En llamada', tipo: 'seg' },
    { clave: 'seg_tipificando', titulo: 'Tipificando', tipo: 'seg' }, { clave: 'seg_descanso', titulo: 'Descanso', tipo: 'seg' },
  ],
  campanas: [{ clave: 'campana', titulo: 'Campaña', tipo: 'texto' }, ...METRICAS],
  listas: [{ clave: 'lista', titulo: 'Base', tipo: 'texto' }, { clave: 'campana', titulo: 'Campaña', tipo: 'texto' }, ...METRICAS,
    { clave: 'conversion_pct', titulo: 'Conversión', tipo: 'pct', ayuda: 'Ventas sobre llamadas que llegaron al vendedor' }],
  resultados: [{ clave: 'resultado', titulo: 'Resultado', tipo: 'texto' }, { clave: 'tipificacion', titulo: 'Tipificación', tipo: 'texto' },
    { clave: 'llamadas', titulo: 'Llamadas', tipo: 'numero' }, { clave: 'pct', titulo: '%', tipo: 'pct' }],
  amd: [{ clave: 'amd_estado', titulo: 'Resultado AMD', tipo: 'texto' }, { clave: 'causa', titulo: 'Causa', tipo: 'texto' },
    { clave: 'llamadas', titulo: 'Llamadas', tipo: 'numero' }, { clave: 'pct', titulo: '%', tipo: 'pct' }],
  descansos: [{ clave: 'vendedor', titulo: 'Vendedor', tipo: 'texto' }, { clave: 'motivo', titulo: 'Motivo', tipo: 'texto' },
    { clave: 'veces', titulo: 'Veces', tipo: 'numero' }, { clave: 'seg_total', titulo: 'Tiempo total', tipo: 'seg' }],
  llamadas: [
    { clave: 'inicio', titulo: 'Inicio', tipo: 'texto' }, { clave: 'telefono', titulo: 'Teléfono', tipo: 'texto' },
    { clave: 'campana', titulo: 'Campaña', tipo: 'texto' }, { clave: 'gateway', titulo: 'Gateway', tipo: 'texto' },
    { clave: 'vendedor', titulo: 'Vendedor', tipo: 'texto' }, { clave: 'resultado', titulo: 'Resultado', tipo: 'texto' },
    { clave: 'tipificacion', titulo: 'Tipificación', tipo: 'texto' }, { clave: 'conversacion_seg', titulo: 'Conversación', tipo: 'seg' },
    { clave: 'colgo', titulo: 'Cortó', tipo: 'texto' }, { clave: 'notas', titulo: 'Notas', tipo: 'texto' },
  ],
};

function celda(v: unknown, c: Columna): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="suave">—</span>;
  if (c.tipo === 'pct') return `${String(v).replace('.', ',')}%`;
  if (c.tipo === 'seg') return duracion(Number(v));
  if (c.tipo === 'numero') return numero(Number(v));
  if (c.tipo === 'si_no') return v ? 'Sí' : 'No';
  return String(v).replace(/_/g, ' ');
}

const hoy = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD en la hora local

export function Reportes() {
  const { puede } = useSesion();
  const [desde, setDesde] = useState(hoy());
  const [hasta, setHasta] = useState(hoy());
  const [campana, setCampana] = useState('');
  const [vendedor, setVendedor] = useState('');
  const [pestana, setPestana] = useState<Pestana>('resumen');
  const { datos: campanas } = useDatos<{ id: number; nombre: string }[]>(puede('campanas.ver', 'ivr.ver') ? '/api/campanas?incluir_archivadas=true' : null);
  const { datos: vendedores } = useDatos<{ id: number; nombre: string }[]>(puede('vendedores.ver', 'usuarios.administrar') ? '/api/usuarios?rol=vendedor&incluir_bajas=true' : null);

  const filtro = useMemo(() => {
    const q = new URLSearchParams({ desde, hasta: hasta < desde ? desde : hasta });
    if (campana) q.set('campana_id', campana);
    if (vendedor) q.set('vendedor_id', vendedor);
    return q.toString();
  }, [desde, hasta, campana, vendedor]);

  const atajo = (dias: number) => {
    const d = new Date();
    d.setDate(d.getDate() - dias);
    setDesde(d.toLocaleDateString('sv-SE'));
    setHasta(hoy());
  };

  return (
    <>
      <Encabezado titulo="Reportes" />
      <div className="fila filtros">
        <label className="fila" style={{ gap: 6 }}><span>Desde</span><input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} style={{ width: 'auto' }} /></label>
        <label className="fila" style={{ gap: 6 }}><span>Hasta</span><input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} style={{ width: 'auto' }} /></label>
        <button onClick={() => atajo(0)}>Hoy</button>
        <button onClick={() => atajo(6)}>7 días</button>
        <button onClick={() => atajo(29)}>30 días</button>
        {campanas && (
          <select value={campana} onChange={(e) => setCampana(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Todas las campañas</option>
            {campanas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        )}
        {vendedores && (
          <select value={vendedor} onChange={(e) => setVendedor(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Todos los vendedores</option>
            {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
          </select>
        )}
      </div>
      <Pestanas opciones={PESTANAS} actual={pestana} onCambiar={setPestana} />
      {pestana === 'resumen' ? <Resumen filtro={filtro} /> : <TablaReporte reporte={pestana} filtro={filtro} columnas={COLUMNAS[pestana]} />}
    </>
  );
}

function Exportar({ reporte, filtro }: { reporte: string; filtro: string }) {
  const { puede } = useSesion();
  if (!puede('reportes.exportar')) return null;
  return <a className="boton" href={`/api/reportes/${reporte}?${filtro}&formato=csv`} download>Exportar a Excel (CSV)</a>;
}

function Resumen({ filtro }: { filtro: string }) {
  const { datos, error } = useDatos<Fila[]>(`/api/reportes/resumen?${filtro}`);
  const { datos: horas } = useDatos<Fila[]>(`/api/reportes/horas?${filtro}`);
  const r = datos?.[0];
  if (!r) return <MensajeError mensaje={error} />;
  const n = (k: string) => Number(r[k] ?? 0);

  // Embudo: cada paso sobre los intentos
  const pasos: [string, number, string?][] = [
    ['Intentos', n('intentos')],
    ['Atendieron', n('atendidas')],
    ['Personas', n('personas'), 'sin contestadores'],
    ['Llegaron al vendedor', n('llegaron_al_vendedor')],
    ['Ventas', n('ventas')],
  ];
  const tope = Math.max(1, n('intentos'));
  const porHora = Array.from({ length: 24 }, (_, h) => horas?.find((x) => Number(x.hora) === h));
  const desdeHora = Math.min(...porHora.map((x, h) => (x ? h : 24)), 9);
  const hastaHora = Math.max(...porHora.map((x, h) => (x ? h : -1)), 21);
  const rango = porHora.slice(desdeHora, hastaHora + 1);
  const maxHora = Math.max(1, ...rango.map((x) => Number(x?.intentos ?? 0)));

  return (
    <div className="pila" style={{ gap: 16 }}>
      <div className="fila"><Exportar reporte="resumen" filtro={filtro} /></div>
      <div className="tiles">
        <div className="tile"><span>Contactabilidad</span><strong className="numero">{String(r.contactabilidad_pct ?? '—')}%</strong></div>
        <div className="tile"><span>Abandono</span><strong className="numero">{String(r.abandono_pct ?? '—')}%</strong></div>
        <div className="tile"><span>Ventas</span><strong className="numero">{numero(n('ventas'))}</strong></div>
        <div className="tile"><span>Conversación promedio</span><strong className="numero">{r.conversacion_promedio_seg ? duracion(n('conversacion_promedio_seg')) : '—'}</strong></div>
        <div className="tile"><span>Contestadores</span><strong className="numero">{numero(n('contestadores'))}</strong></div>
        <div className="tile"><span>Abandonos</span><strong className="numero">{numero(n('abandonos'))}</strong></div>
      </div>

      <section className="tarjeta">
        <h2>Embudo</h2>
        <div className="pila">
          {pasos.map(([t, v, nota]) => (
            <div key={t} className="embudo">
              <span>{t}{nota && <small className="suave"> ({nota})</small>}</span>
              <div className="medidor" title={`${numero(v)} · ${((v / tope) * 100).toFixed(1)}% de los intentos`}><div style={{ width: `${(v / tope) * 100}%` }} /></div>
              <strong className="numero">{numero(v)}</strong>
              <span className="suave numero chico">{((v / tope) * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </section>

      <section className="tarjeta">
        <h2>Intentos por hora</h2>
        <div className="barras" role="img" aria-label="Intentos por hora">
          {rango.map((x, i) => {
            const v = Number(x?.intentos ?? 0);
            return (
              <div key={i} className="barra">
                <div style={{ height: `${(v / maxHora) * 100}%` }} />
                <span className="tip">{desdeHora + i}:00 · {numero(v)} intentos · {numero(Number(x?.personas ?? 0))} personas · {numero(Number(x?.ventas ?? 0))} ventas</span>
              </div>
            );
          })}
        </div>
        <div className="ejes">{rango.map((_, i) => <span key={i}>{desdeHora + i}</span>)}</div>
        <small className="suave chico">La tabla completa está en la pestaña "Por hora".</small>
      </section>
    </div>
  );
}

function TablaReporte({ reporte, filtro, columnas }: { reporte: string; filtro: string; columnas: Columna[] }) {
  const { datos, error, cargando } = useDatos<Fila[]>(`/api/reportes/${reporte}?${filtro}`);
  const { puede } = useSesion();
  const filas = datos ?? [];
  return (
    <div className="pila" style={{ gap: 12 }}>
      <div className="fila separada">
        <span className="suave">{cargando ? 'Cargando…' : `${numero(filas.length)} filas${reporte === 'llamadas' && filas.length === 100 ? ' (las últimas 100; el CSV trae todas)' : ''}`}</span>
        <Exportar reporte={reporte} filtro={filtro} />
      </div>
      <MensajeError mensaje={error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead>
            <tr>
              {columnas.map((c) => <th key={c.clave} className={c.tipo && c.tipo !== 'texto' ? 'der' : ''} title={c.ayuda}>{c.titulo}{c.ayuda ? ' ⓘ' : ''}</th>)}
              {reporte === 'llamadas' && puede('grabaciones.escuchar') && <th></th>}
            </tr>
          </thead>
          <tbody>
            {filas.map((f, i) => (
              <tr key={i}>
                {columnas.map((c) => <td key={c.clave} className={c.tipo && c.tipo !== 'texto' ? 'der numero' : ''}>{celda(f[c.clave], c)}</td>)}
                {reporte === 'llamadas' && puede('grabaciones.escuchar') && (
                  <td>{f.tiene_grabacion ? <Link to={`/grabaciones?llamada=${String(f.id)}`}>Escuchar</Link> : null}</td>
                )}
              </tr>
            ))}
            {!cargando && filas.length === 0 && <tr><td colSpan={columnas.length + 1} className="vacio">Sin datos en el período.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
