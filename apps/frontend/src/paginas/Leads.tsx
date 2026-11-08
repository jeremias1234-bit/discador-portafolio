// Sección Leads: clientes que le respondieron al bot de WhatsApp (los manda el Detector de la PC
// del bot). Números del día, estado del Detector, turno de los vendedores con "Recibe leads", la
// lista con filtros y reasignación, y la configuración del Detector (textos disparadores y tokens).
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { TablaAvisos, type Aviso } from '../componentes/Avisos';
import { Campo, Encabezado, fechaHora, MensajeError, numero, useAccion, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import { useTiempoReal } from '../tiempoReal';

interface Detector {
  pc_bot: string;
  version: string | null;
  modo: 'principal' | 'respaldo' | 'caido';
  enviados_hoy: number;
  en_cola: number;
  ultimo_latido: string;
  vivo: boolean;
}

interface Resumen {
  hoy: { hoy: number; portabilidad: number; fibra: number; sin_dni: number; pendientes: number; contactados: number; descartados: number; minutos_hasta_contacto: number | null };
  vendedores: { vendedor_id: number; nombre: string; hoy: number; pendientes: number; contactados: number; conectado: boolean }[];
  turno: {
    regla: { id: number; nombre: string; modo: 'conectadas' | 'todas' } | null;
    vendedores: { id: number; nombre: string; conectado: boolean }[];
    proximo: number | null;
  };
  detectores: Detector[];
}

const hoyLocal = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD

export function Leads() {
  const { puede } = useSesion();
  const { suscribir } = useTiempoReal();
  const [filtros, setFiltros] = useState({ desde: hoyLocal(), hasta: hoyLocal(), estado: '', interes: '' });
  const consulta = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v)).toString();
  const resumen = useDatos<Resumen>('/api/leads/resumen');
  const leads = useDatos<Aviso[]>(`/api/leads?${consulta}`);
  const { recargar: recargarResumen } = resumen;
  const { recargar: recargarLeads } = leads;

  useEffect(() => suscribir('avisos', () => {
    void recargarResumen();
    void recargarLeads();
  }), [suscribir, recargarResumen, recargarLeads]);
  useEffect(() => {
    const t = setInterval(() => {
      void recargarResumen();
      void recargarLeads();
    }, 15_000);
    return () => clearInterval(t);
  }, [recargarResumen, recargarLeads]);

  const vendedores = useMemo(
    () => (resumen.datos?.turno.vendedores ?? []).map((v) => ({ id: v.id, nombre: v.nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre)),
    [resumen.datos],
  );
  const h = resumen.datos?.hoy;
  const proximo = resumen.datos?.turno.vendedores.find((v) => v.id === resumen.datos?.turno.proximo);

  return (
    <>
      <Encabezado titulo="Leads del bot de WhatsApp">
        <a className="boton" href="/api/extension.zip"><button>Extensión de los vendedores</button></a>
        {puede('leads.editar') && <a className="boton" href="/api/detector.zip"><button>Descargar Detector (PC del bot)</button></a>}
      </Encabezado>
      <MensajeError mensaje={resumen.error} />

      <div className="kpis" style={{ marginBottom: 14 }}>
        <div className="kpi bueno"><strong className="numero">{numero(h?.hoy)}</strong><span>Leads hoy</span></div>
        <div className="kpi"><strong className="numero">{numero(h?.portabilidad)}</strong><span>Portabilidad</span></div>
        <div className="kpi"><strong className="numero">{numero(h?.fibra)}</strong><span>Fibra</span></div>
        <div className={`kpi ${h?.sin_dni ? 'atencion' : ''}`}><strong className="numero">{numero(h?.sin_dni)}</strong><span>Sin DNI (revisar)</span></div>
        <div className={`kpi ${h?.pendientes ? 'atencion' : ''}`}><strong className="numero">{numero(h?.pendientes)}</strong><span>Pendientes</span></div>
        <div className="kpi"><strong className="numero">{numero(h?.contactados)}</strong><span>Contactados hoy</span></div>
        <div className="kpi">
          <strong className="numero">{h?.minutos_hasta_contacto == null ? '—' : `${h.minutos_hasta_contacto.toLocaleString('es-AR')} min`}</strong>
          <span>Demora hasta contactar</span>
        </div>
      </div>

      <div className="monitor-grilla">
        <div className="pila" style={{ gap: 14 }}>
          <EstadoDetectores detectores={resumen.datos?.detectores ?? null} />

          {puede('leads.editar', 'vendedores.ivr') && <ReglasReparto onCambio={() => void recargarResumen()} />}

          <section className="panel">
            <h2 className="panel-titulo">Leads</h2>
            <div className="fila filtros">
              <label>Desde <input type="date" value={filtros.desde} onChange={(e) => setFiltros({ ...filtros, desde: e.target.value })} /></label>
              <label>Hasta <input type="date" value={filtros.hasta} onChange={(e) => setFiltros({ ...filtros, hasta: e.target.value })} /></label>
              <select value={filtros.estado} onChange={(e) => setFiltros({ ...filtros, estado: e.target.value })}>
                <option value="">Todos los estados</option>
                <option value="pendiente">Pendientes</option>
                <option value="contactado">Contactados</option>
                <option value="descartado">Descartados</option>
              </select>
              <select value={filtros.interes} onChange={(e) => setFiltros({ ...filtros, interes: e.target.value })}>
                <option value="">Porta y fibra</option>
                <option value="portabilidad">Solo portabilidad</option>
                <option value="fibra">Solo fibra</option>
              </select>
            </div>
            <MensajeError mensaje={leads.error} />
            <TablaAvisos avisos={leads.datos ?? []} leads conVendedor vendedores={vendedores} onCambio={() => void recargarLeads()} />
          </section>

          {puede('leads.editar') && <ConfiguracionDetector />}
        </div>

        <div className="pila" style={{ gap: 14 }}>
          <section className="panel">
            <h2 className="panel-titulo">Turno ahora{resumen.datos?.turno.regla ? ` · ${resumen.datos.turno.regla.nombre}` : ''}</h2>
            {resumen.datos && resumen.datos.turno.vendedores.length === 0 ? (
              <div className="alerta">
                Con la regla de ahora nadie recibe leads: quedan sin asignar. Elegí vendedoras en <strong>Quiénes reciben los leads</strong>.
              </div>
            ) : (
              <>
                <div className="fila" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {(resumen.datos?.turno.vendedores ?? []).map((v) => (
                    <span key={v.id} className={`chip ${v.conectado ? 'ok' : ''}`} title={v.conectado ? 'Con la extensión o el panel abiertos' : 'Desconectado'}>
                      {v.id === resumen.datos?.turno.proximo ? '▶ ' : ''}{v.nombre}
                    </span>
                  ))}
                </div>
                {proximo && <div className="suave chico" style={{ marginTop: 6 }}>El próximo lead le llega a <strong>{proximo.nombre}</strong>.</div>}
              </>
            )}
          </section>

          <section className="panel">
            <h2 className="panel-titulo">Vendedores · leads de hoy</h2>
            <table className="tabla compacta">
              <thead><tr><th>Vendedor</th><th className="der">Hoy</th><th className="der">Pendientes</th><th className="der">Contactados</th></tr></thead>
              <tbody>
                {(resumen.datos?.vendedores ?? []).map((v) => (
                  <tr key={v.vendedor_id}>
                    <td><span className={`chip ${v.conectado ? 'ok' : ''}`}>{v.nombre}</span></td>
                    <td className="der numero">{v.hoy}</td>
                    <td className="der numero">{v.pendientes}</td>
                    <td className="der numero">{v.contactados}</td>
                  </tr>
                ))}
                {resumen.datos?.vendedores.length === 0 && <tr><td colSpan={4} className="vacio">Sin leads hoy.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2 className="panel-titulo">Cómo funciona</h2>
            <div className="suave chico pila" style={{ gap: 6 }}>
              <div>El <strong>Detector</strong> es una extensión de Chrome en la PC donde está abierto WhatsApp Web con el bot. Solo lee: no escribe ni abre chats.</div>
              <div>Cuando un cliente <strong>elige Claro</strong> en el primer menú del bot, el lead le llega en el momento a la vendedora del turno, en la pestaña LEADS de su extensión. Personal, Tuenti y Movistar no son leads.</div>
              <div>Un mismo número genera un solo lead: cuando después elige portabilidad o fibra, manda el DNI o la dirección, se completa el mismo lead.</div>
              <div>Quién lo recibe depende de las reglas de <strong>Quiénes reciben los leads</strong>, por día y horario. Es aparte del IVR.</div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

interface Regla {
  id: number;
  nombre: string;
  por_defecto: boolean;
  dias: number[];
  desde: string | null;
  hasta: string | null;
  modo: 'conectadas' | 'todas';
  activa: boolean;
  orden: number;
  vendedores: number[];
}
interface DatosReglas {
  reglas: Regla[];
  vendedores: { id: number; nombre: string; pendientes: number; conectado: boolean }[];
  vigente: number | null;
  proximo: number | null;
}

const DIAS: [number, string][] = [[1, 'L'], [2, 'M'], [3, 'X'], [4, 'J'], [5, 'V'], [6, 'S'], [7, 'D']];
const TEXTO_MODO_REGLA: Record<Regla['modo'], string> = {
  conectadas: 'Solo las conectadas (horario de trabajo)',
  todas: 'Todas, aunque no estén conectadas (fuera de horario)',
};

/**
 * Reglas de reparto de los leads: por días y horario, a quiénes y cómo. Gana la primera regla (de
 * arriba hacia abajo) que coincide con el momento; si no coincide ninguna, la por defecto.
 */
function ReglasReparto({ onCambio }: { onCambio: () => void }) {
  const { suscribir } = useTiempoReal();
  const datos = useDatos<DatosReglas>('/api/leads/reglas');
  const { ocupado, error, ejecutar } = useAccion();
  const { recargar } = datos;

  useEffect(() => suscribir('avisos', () => void recargar()), [suscribir, recargar]);
  useEffect(() => {
    const t = setInterval(() => void recargar(), 30_000); // quién está conectado y qué regla vale
    return () => clearInterval(t);
  }, [recargar]);

  const listo = () => {
    void recargar();
    onCambio();
  };
  const nueva = async () => {
    const ok = await ejecutar(() => api.post('/api/leads/reglas', {
      nombre: 'Fuera de horario', dias: [1, 2, 3, 4, 5, 6, 7], desde: '21:00', hasta: '10:00', modo: 'todas', activa: true, vendedores: [],
    }));
    if (ok) listo();
  };
  const reglas = [...(datos.datos?.reglas ?? [])].sort((a, b) => Number(a.por_defecto) - Number(b.por_defecto) || a.orden - b.orden || a.id - b.id);
  const conHorario = reglas.filter((r) => !r.por_defecto);
  const vigente = reglas.find((r) => r.id === datos.datos?.vigente);
  const mover = async (r: Regla, delta: -1 | 1) => {
    const i = conHorario.findIndex((x) => x.id === r.id);
    const otra = conHorario[i + delta];
    if (!otra) return;
    const ok = await ejecutar(async () => {
      await api.patch(`/api/leads/reglas/${r.id}`, { orden: otra.orden });
      await api.patch(`/api/leads/reglas/${otra.id}`, { orden: r.orden === otra.orden ? r.orden + delta : r.orden });
    });
    if (ok) listo();
  };

  return (
    <section className="panel">
      <div className="fila separada" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 className="panel-titulo" style={{ margin: 0 }}>Quiénes reciben los leads</h2>
        <button className="chico primario" disabled={ocupado} onClick={() => void nueva()}>Nueva regla</button>
      </div>
      <div className="suave chico" style={{ margin: '6px 0 10px' }}>
        Armá una regla por horario: en horario de trabajo, a las que están conectadas; fuera de horario, a quienes elijas aunque no estén conectadas (el lead las espera en la extensión).
        Si dos reglas coinciden, gana la de más arriba. Si no coincide ninguna, se usa la regla por defecto. Los cambios valen desde el próximo lead.
      </div>
      {vigente && (
        <div className="alerta info" style={{ marginBottom: 10 }}>
          Ahora se aplica: <strong>{vigente.nombre}</strong>
          {datos.datos?.proximo && <> · el próximo lead le llega a <strong>{datos.datos.vendedores.find((v) => v.id === datos.datos?.proximo)?.nombre}</strong></>}
        </div>
      )}
      <MensajeError mensaje={datos.error ?? error} />
      <div className="pila" style={{ gap: 10 }}>
        {reglas.map((r) => (
          <TarjetaRegla
            key={`${r.id}-${r.orden}`}
            regla={r}
            vigente={r.id === datos.datos?.vigente}
            vendedores={datos.datos?.vendedores ?? []}
            puedeSubir={!r.por_defecto && conHorario[0]?.id !== r.id}
            puedeBajar={!r.por_defecto && conHorario[conHorario.length - 1]?.id !== r.id}
            onMover={(d) => void mover(r, d)}
            onCambio={listo}
          />
        ))}
      </div>
    </section>
  );
}

function TarjetaRegla({ regla, vigente, vendedores, puedeSubir, puedeBajar, onMover, onCambio }: {
  regla: Regla;
  vigente: boolean;
  vendedores: DatosReglas['vendedores'];
  puedeSubir: boolean;
  puedeBajar: boolean;
  onMover: (delta: -1 | 1) => void;
  onCambio: () => void;
}) {
  const { ocupado, error, ejecutar } = useAccion();
  const [f, setF] = useState(regla);
  const [borrando, setBorrando] = useState(false);
  useEffect(() => setF(regla), [regla]);
  const cambiado = JSON.stringify(f) !== JSON.stringify(regla);
  const marcar = (id: number, si: boolean) => setF({ ...f, vendedores: si ? [...f.vendedores, id] : f.vendedores.filter((x) => x !== id) });
  const dia = (d: number) => setF({ ...f, dias: f.dias.includes(d) ? f.dias.filter((x) => x !== d) : [...f.dias, d].sort() });

  const guardar = async () => {
    const cuerpo = regla.por_defecto
      ? { nombre: f.nombre, modo: f.modo, vendedores: f.vendedores }
      : { nombre: f.nombre, dias: f.dias, desde: f.desde, hasta: f.hasta, modo: f.modo, activa: f.activa, vendedores: f.vendedores };
    if (await ejecutar(() => api.patch(`/api/leads/reglas/${regla.id}`, cuerpo))) onCambio();
  };
  const borrar = async () => {
    if (await ejecutar(() => api.borrar(`/api/leads/reglas/${regla.id}`))) onCambio();
  };

  return (
    <div className="tarjeta" style={{ padding: 12, borderColor: vigente ? 'var(--acento)' : undefined, opacity: f.activa ? 1 : 0.7 }}>
      <div className="fila separada" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="fila" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} maxLength={80} style={{ fontWeight: 600, maxWidth: 260 }} aria-label="Nombre de la regla" />
          {vigente && <span className="chip ok">Se aplica ahora</span>}
          {regla.por_defecto && <span className="chip">Por defecto</span>}
          {!f.activa && <span className="chip">Apagada</span>}
        </div>
        <div className="fila" style={{ gap: 4 }}>
          {!regla.por_defecto && (
            <>
              <button className="chico" disabled={ocupado || !puedeSubir} onClick={() => onMover(-1)} title="Subir (gana sobre las de abajo)">↑</button>
              <button className="chico" disabled={ocupado || !puedeBajar} onClick={() => onMover(1)} title="Bajar">↓</button>
            </>
          )}
        </div>
      </div>

      {!regla.por_defecto && (
        <div className="fila" style={{ gap: 12, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
          <div className="fila" style={{ gap: 4 }} role="group" aria-label="Días">
            {DIAS.map(([d, t]) => (
              <button key={d} type="button" className={`chico ${f.dias.includes(d) ? 'primario' : ''}`} onClick={() => dia(d)} aria-pressed={f.dias.includes(d)} title={['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'][d]}>{t}</button>
            ))}
          </div>
          <label className="fila" style={{ gap: 6 }}>de <input type="time" value={f.desde ?? ''} onChange={(e) => setF({ ...f, desde: e.target.value })} /></label>
          <label className="fila" style={{ gap: 6 }}>a <input type="time" value={f.hasta ?? ''} onChange={(e) => setF({ ...f, hasta: e.target.value })} /></label>
          <label className="fila" style={{ gap: 6 }}><input type="checkbox" checked={f.activa} onChange={(e) => setF({ ...f, activa: e.target.checked })} /> Activa</label>
        </div>
      )}
      {!regla.por_defecto && f.desde && f.hasta && f.desde > f.hasta && (
        <div className="suave chico" style={{ marginTop: 4 }}>Cruza la medianoche: de {f.desde} de un día seleccionado a {f.hasta} del día siguiente.</div>
      )}

      <div style={{ marginTop: 8 }}>
        <select value={f.modo} onChange={(e) => setF({ ...f, modo: e.target.value as Regla['modo'] })} aria-label="A quiénes de la regla">
          {(Object.keys(TEXTO_MODO_REGLA) as Regla['modo'][]).map((m) => <option key={m} value={m}>{TEXTO_MODO_REGLA[m]}</option>)}
        </select>
      </div>

      <div className="fila" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {vendedores.map((v) => (
          <label key={v.id} className={`chip ${v.conectado ? 'ok' : ''}`} style={{ cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center' }} title={v.conectado ? 'Con la extensión o el panel abiertos' : 'Desconectada'}>
            <input type="checkbox" checked={f.vendedores.includes(v.id)} onChange={(e) => marcar(v.id, e.target.checked)} />
            {v.nombre}{v.pendientes > 0 ? ` (${v.pendientes})` : ''}
          </label>
        ))}
        <button type="button" className="chico" onClick={() => setF({ ...f, vendedores: vendedores.map((v) => v.id) })}>Todas</button>
        <button type="button" className="chico" onClick={() => setF({ ...f, vendedores: [] })}>Ninguna</button>
      </div>
      {f.vendedores.length === 0 && <div className="alerta" style={{ marginTop: 8 }}>Sin vendedoras: mientras se aplique esta regla, los leads quedan sin asignar.</div>}

      <MensajeError mensaje={error} />
      <div className="fila" style={{ gap: 6, marginTop: 8 }}>
        <button className="primario chico" disabled={ocupado || !cambiado || (!regla.por_defecto && f.dias.length === 0)} onClick={() => void guardar()}>Guardar</button>
        {cambiado && <button className="chico" onClick={() => setF(regla)}>Deshacer</button>}
        {!regla.por_defecto && (borrando ? (
          <>
            <span className="suave chico">¿Borrar la regla?</span>
            <button className="chico peligro" disabled={ocupado} onClick={() => void borrar()}>Sí, borrar</button>
            <button className="chico" onClick={() => setBorrando(false)}>No</button>
          </>
        ) : <button className="chico" onClick={() => setBorrando(true)}>Borrar</button>)}
      </div>
    </div>
  );
}

const TEXTO_MODO: Record<Detector['modo'], [string, string]> = {
  principal: ['Leyendo todos los chats', 'ok'],
  respaldo: ['Modo respaldo (solo chat abierto)', 'aviso'],
  caido: ['No puede leer WhatsApp', 'peligro'],
};

function EstadoDetectores({ detectores }: { detectores: Detector[] | null }) {
  if (!detectores) return null;
  return (
    <section className="panel">
      <h2 className="panel-titulo">Detector de la PC del bot</h2>
      {detectores.length === 0 ? (
        <div className="alerta">
          Ningún Detector mandó señal desde que arrancó el discador. Revisá que la PC del bot tenga Chrome abierto con WhatsApp Web y la extensión del Detector instalada.
        </div>
      ) : (
        <table className="tabla compacta">
          <thead><tr><th>PC</th><th>Estado</th><th>Última señal</th><th className="der">Enviados hoy</th><th className="der">En cola</th><th>Versión</th></tr></thead>
          <tbody>
            {detectores.map((d) => {
              const [texto, clase] = d.vivo ? TEXTO_MODO[d.modo] : ['Sin señal', 'peligro'];
              return (
                <tr key={d.pc_bot}>
                  <td><strong>{d.pc_bot}</strong></td>
                  <td><span className={`chip ${clase}`}>{d.vivo ? '✅' : '⚠️'} {texto}</span></td>
                  <td className="suave">{fechaHora(d.ultimo_latido)}</td>
                  <td className="der numero">{d.enviados_hoy}</td>
                  <td className={`der numero ${d.en_cola ? 'peligro' : ''}`}>{d.en_cola}</td>
                  <td className="suave">{d.version ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface Parametro { clave: string; valor: unknown; editable: boolean }
interface TokenServicio { id: number; nombre: string; creado_en: string; creado_por: string | null; revocado_en: string | null; ultimo_uso_en: string | null; ultimo_ip: string | null }

const lineas = (v: unknown) => (Array.isArray(v) ? v.join('\n') : '');
const deLineas = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);

function ConfiguracionDetector() {
  const config = useDatos<Parametro[]>('/api/configuracion');
  const tokens = useDatos<TokenServicio[]>('/api/leads/tokens');
  const { ocupado, error, ejecutar } = useAccion();
  const [f, setF] = useState<{ porta: string; fibra: string; companias: string; horas: number; antiguedad: number } | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [nombreToken, setNombreToken] = useState('Detector PC del bot');
  const [tokenNuevo, setTokenNuevo] = useState<string | null>(null);

  useEffect(() => {
    if (!config.datos || f) return;
    const v = (clave: string) => config.datos!.find((p) => p.clave === clave)?.valor;
    setF({
      porta: lineas(v('leads.disparadores_portabilidad')),
      fibra: lineas(v('leads.disparadores_fibra')),
      companias: lineas(v('leads.companias')),
      horas: Number(v('leads.horas_deduplicacion') ?? 24),
      antiguedad: Number(v('leads.antiguedad_max_min') ?? 10),
    });
  }, [config.datos, f]);

  const guardar = async () => {
    if (!f) return;
    const ok = await ejecutar(() => api.patch('/api/configuracion', {
      'leads.disparadores_portabilidad': deLineas(f.porta),
      'leads.disparadores_fibra': deLineas(f.fibra),
      'leads.companias': deLineas(f.companias),
      'leads.horas_deduplicacion': f.horas,
      'leads.antiguedad_max_min': f.antiguedad,
    }));
    if (ok) setGuardado(true);
  };
  const crearToken = async () => {
    await ejecutar(async () => {
      const r = await api.post<{ token: string }>('/api/leads/tokens', { nombre: nombreToken });
      setTokenNuevo(r.token);
      void tokens.recargar();
    });
  };
  const revocar = async (t: TokenServicio) => {
    if (!window.confirm(`¿Revocar el token "${t.nombre}"? El Detector que lo use deja de mandar leads.`)) return;
    if (await ejecutar(() => api.borrar(`/api/leads/tokens/${t.id}`))) void tokens.recargar();
  };

  return (
    <section className="panel">
      <h2 className="panel-titulo">Configuración del Detector</h2>
      <MensajeError mensaje={config.error ?? error} />
      {f && (
        <div className="pila" style={{ gap: 12 }}>
          <div className="rejilla">
            <Campo etiqueta="Disparadores de portabilidad" ayuda="Un texto por línea. Si el último mensaje del bot contiene alguno y el cliente responde, sale el lead. Se compara sin mayúsculas, acentos ni emojis.">
              <textarea rows={3} value={f.porta} onChange={(e) => { setF({ ...f, porta: e.target.value }); setGuardado(false); }} />
            </Campo>
            <Campo etiqueta="Disparadores de fibra" ayuda="Igual, para el pedido de domicilio. La respuesta del cliente se guarda como dirección del lead.">
              <textarea rows={3} value={f.fibra} onChange={(e) => { setF({ ...f, fibra: e.target.value }); setGuardado(false); }} />
            </Campo>
            <Campo etiqueta="Compañías que generan lead" ayuda="Una por línea (hoy: Claro). Se reconoce por lo que el cliente eligió en el primer menú del bot o por su mensaje “Veo que eres cliente de…”. Los demás no son leads; si no se puede saber la compañía, tampoco se manda. Vacío = todas.">
              <textarea rows={2} value={f.companias} onChange={(e) => { setF({ ...f, companias: e.target.value }); setGuardado(false); }} />
            </Campo>
            <Campo etiqueta="Un lead por número cada (horas)" ayuda="Los mensajes siguientes del mismo número completan ese lead en lugar de crear otro.">
              <input type="number" min={1} max={720} value={f.horas} onChange={(e) => { setF({ ...f, horas: Number(e.target.value) }); setGuardado(false); }} />
            </Campo>
            <Campo etiqueta="Ignorar mensajes más viejos que (minutos)" ayuda="Al abrir WhatsApp Web no se disparan los chats viejos.">
              <input type="number" min={1} max={1440} value={f.antiguedad} onChange={(e) => { setF({ ...f, antiguedad: Number(e.target.value) }); setGuardado(false); }} />
            </Campo>
          </div>
          <div className="fila">
            <button className="primario" disabled={ocupado} onClick={() => void guardar()}>Guardar</button>
            {guardado && <span className="chip ok">Guardado: el Detector lo toma en menos de un minuto</span>}
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 18 }}>Tokens del Detector</h3>
      <div className="suave chico" style={{ marginBottom: 8 }}>
        El Detector se identifica con un token: solo sirve para cargar leads, no para entrar al panel. Se muestra una sola vez al crearlo; copialo en las opciones de la extensión del Detector.
      </div>
      {tokenNuevo && (
        <div className="alerta info">
          Token nuevo (copialo ahora, no se vuelve a mostrar): <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{tokenNuevo}</code>{' '}
          <button className="chico" onClick={() => void navigator.clipboard.writeText(tokenNuevo)}>Copiar</button>
        </div>
      )}
      <div className="fila" style={{ marginBottom: 8 }}>
        <input value={nombreToken} onChange={(e) => setNombreToken(e.target.value)} maxLength={80} style={{ maxWidth: 260 }} />
        <button disabled={ocupado || nombreToken.trim().length < 2} onClick={() => void crearToken()}>Crear token</button>
      </div>
      <table className="tabla compacta">
        <thead><tr><th>Nombre</th><th>Creado</th><th>Último uso</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          {(tokens.datos ?? []).map((t) => (
            <tr key={t.id} className={t.revocado_en ? 'inactivo' : ''}>
              <td>{t.nombre}</td>
              <td className="suave">{fechaHora(t.creado_en)}{t.creado_por ? ` · ${t.creado_por}` : ''}</td>
              <td className="suave">{t.ultimo_uso_en ? `${fechaHora(t.ultimo_uso_en)} · ${t.ultimo_ip ?? ''}` : 'Nunca'}</td>
              <td>{t.revocado_en ? <span className="chip">Revocado</span> : <span className="chip ok">Vigente</span>}</td>
              <td>{!t.revocado_en && <button className="chico" disabled={ocupado} onClick={() => void revocar(t)}>Revocar</button>}</td>
            </tr>
          ))}
          {tokens.datos?.length === 0 && <tr><td colSpan={5} className="vacio">Todavía no hay tokens.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
