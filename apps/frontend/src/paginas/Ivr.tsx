// Sección IVR: campañas IVR con sus números del día, turno de los vendedores que reciben los
// avisos (cliente que marcó llamada o WhatsApp), los avisos y la extensión de Chrome.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { TablaAvisos, type Aviso } from '../componentes/Avisos';
import { ComparacionAudios } from '../componentes/ComparacionAudios';
import { Campo, Encabezado, MensajeError, Modal, numero, useAccion, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import { useTiempoReal } from '../tiempoReal';
import { ESTADO_CAMPANA, NuevaCampana, type EstadoCampana } from './Campanas';

interface CampanaIvr {
  id: number;
  nombre: string;
  estado: EstadoCampana;
  ivr_destino: 'vendedor' | 'aviso';
  audio_id: number | null;
  audio_b_id: number | null;
  audio_b_pct: number;
  ivr_tecla_llamada: string | null;
  ivr_tecla_whatsapp: string | null;
  restantes: number;
  hoy: { intentos: number; atendidas: number; contestadores: number; cortaron: number; sin_marcar: number; no_llame: number; avisos: number } | null;
  avisos_hoy: { llamada: number; whatsapp: number };
  turno: { vendedores: { id: number; nombre: string; conectado: boolean }[]; proximo: number | null } | null;
}

interface Resumen {
  campanas: CampanaIvr[];
  vendedores: { vendedor_id: number; nombre: string; hoy: number; pendientes: number; contactados: number; conectado: boolean }[];
}

const hoyLocal = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD

export function Ivr() {
  const { puede } = useSesion();
  const { suscribir } = useTiempoReal();
  const navegar = useNavigate();
  const [nueva, setNueva] = useState(false);
  const [filtros, setFiltros] = useState({ desde: hoyLocal(), hasta: hoyLocal(), estado: '', contacto: '', campana_id: '' });
  const verAvisos = puede('ivr.avisos');
  const consulta = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v)).toString();
  const resumen = useDatos<Resumen>('/api/ivr/resumen');
  const avisos = useDatos<Aviso[]>(verAvisos ? `/api/avisos?${consulta}` : null);
  const { recargar: recargarResumen } = resumen;
  const { recargar: recargarAvisos } = avisos;

  useEffect(() => suscribir('avisos', () => {
    void recargarResumen();
    void recargarAvisos();
  }), [suscribir, recargarResumen, recargarAvisos]);
  useEffect(() => {
    const t = setInterval(() => void recargarResumen(), 15_000);
    return () => clearInterval(t);
  }, [recargarResumen]);

  // Vendedores para reasignar: los que están en algún turno
  const vendedores = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of resumen.datos?.campanas ?? []) for (const v of c.turno?.vendedores ?? []) m.set(v.id, v.nombre);
    return [...m].map(([id, nombre]) => ({ id, nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [resumen.datos]);

  const total = (resumen.datos?.campanas ?? []).reduce(
    (t, c) => ({
      intentos: t.intentos + (c.hoy?.intentos ?? 0), atendidas: t.atendidas + (c.hoy?.atendidas ?? 0),
      llamada: t.llamada + c.avisos_hoy.llamada, whatsapp: t.whatsapp + c.avisos_hoy.whatsapp,
    }),
    { intentos: 0, atendidas: 0, llamada: 0, whatsapp: 0 },
  );
  const pendientes = (resumen.datos?.vendedores ?? []).reduce((t, v) => t + v.pendientes, 0);

  return (
    <>
      <Encabezado titulo="IVR">
        <a className="boton" href="/api/extension.zip"><button>Descargar extensión de Chrome</button></a>
        {puede('ivr.editar') && <button className="primario" onClick={() => setNueva(true)}>Nueva campaña IVR</button>}
      </Encabezado>
      <MensajeError mensaje={resumen.error} />

      <div className="kpis" style={{ marginBottom: 14 }}>
        <div className="kpi"><strong className="numero">{numero(total.intentos)}</strong><span>Llamadas hoy</span></div>
        <div className="kpi"><strong className="numero">{numero(total.atendidas)}</strong><span>Atendieron</span></div>
        <div className="kpi bueno"><strong className="numero">{numero(total.llamada)}</strong><span>📞 Quieren llamada</span></div>
        <div className="kpi bueno"><strong className="numero">{numero(total.whatsapp)}</strong><span>💬 Quieren WhatsApp</span></div>
        <div className={`kpi ${pendientes ? 'atencion' : ''}`}><strong className="numero">{numero(pendientes)}</strong><span>Avisos pendientes</span></div>
      </div>

      <div className="monitor-grilla">
        <div className="pila" style={{ gap: 14 }}>
          {(resumen.datos?.campanas ?? []).map((c) => <TarjetaCampana key={c.id} c={c} onCambio={() => void recargarResumen()} />)}
          {resumen.datos?.campanas.length === 0 && (
            <section className="panel"><div className="vacio">Todavía no hay campañas IVR. Creá una con "Nueva campaña IVR".</div></section>
          )}

          {verAvisos && (
            <section className="panel">
              <h2 className="panel-titulo">Avisos</h2>
              <div className="fila filtros">
                <label>Desde <input type="date" value={filtros.desde} onChange={(e) => setFiltros({ ...filtros, desde: e.target.value })} /></label>
                <label>Hasta <input type="date" value={filtros.hasta} onChange={(e) => setFiltros({ ...filtros, hasta: e.target.value })} /></label>
                <select value={filtros.estado} onChange={(e) => setFiltros({ ...filtros, estado: e.target.value })}>
                  <option value="">Todos los estados</option>
                  <option value="pendiente">Pendientes</option>
                  <option value="contactado">Contactados</option>
                  <option value="descartado">Descartados</option>
                </select>
                <select value={filtros.contacto} onChange={(e) => setFiltros({ ...filtros, contacto: e.target.value })}>
                  <option value="">Llamada y WhatsApp</option>
                  <option value="llamada">Solo llamada</option>
                  <option value="whatsapp">Solo WhatsApp</option>
                </select>
                <select value={filtros.campana_id} onChange={(e) => setFiltros({ ...filtros, campana_id: e.target.value })}>
                  <option value="">Todas las campañas</option>
                  {(resumen.datos?.campanas ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
              </div>
              <MensajeError mensaje={avisos.error} />
              <TablaAvisos avisos={avisos.datos ?? []} conVendedor vendedores={vendedores} onCambio={() => void recargarAvisos()} />
            </section>
          )}
        </div>

        <div className="pila" style={{ gap: 14 }}>
          <section className="panel">
            <h2 className="panel-titulo">Vendedores · avisos de hoy</h2>
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
                {resumen.datos?.vendedores.length === 0 && <tr><td colSpan={4} className="vacio">Sin avisos hoy.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2 className="panel-titulo">Extensión de Chrome para los vendedores</h2>
            <ol className="pila" style={{ gap: 6, paddingLeft: 18, margin: 0 }}>
              <li><a href="/api/extension.zip">Descargá la extensión</a> y descomprimila: queda la carpeta <code>discador-avisos</code>.</li>
              <li>En Chrome abrí <code>chrome://extensions</code>, activá <strong>Modo de desarrollador</strong> (arriba a la derecha) y tocá <strong>Cargar descomprimida</strong>. Elegí esa carpeta.</li>
              <li>Fijá el ícono con el alfiler de la barra de extensiones y abrilo: se ingresa con el mismo usuario y clave del discador.</li>
              <li>La PC tiene que tener instalado el certificado del discador (el mismo que para entrar al panel).</li>
            </ol>
            <div className="suave chico">
              Cuando un cliente marca, al vendedor del turno le aparece una notificación con sonido y el número en el panel lateral, con su nombre y si quiere llamada o WhatsApp.
              El turno es entre los vendedores asignados a la campaña con <strong>Recibe IVR</strong>; si alguno tiene la extensión o el panel abiertos, se reparte solo entre los conectados.
            </div>
          </section>
        </div>
      </div>

      {nueva && <NuevaCampana tipoInicial="ivr" onCerrar={() => setNueva(false)} onCreada={(id) => navegar(`/campanas/${id}`)} />}
    </>
  );
}

function TarjetaCampana({ c, onCambio }: { c: CampanaIvr; onCambio: () => void }) {
  const { puede } = useSesion();
  const { ocupado, error, ejecutar } = useAccion();
  const [probar, setProbar] = useState(false);
  const [texto, clase] = ESTADO_CAMPANA[c.estado];
  const h = c.hoy;
  const cambiarEstado = async (estado: 'activa' | 'pausada') => {
    if (await ejecutar(() => api.post(`/api/campanas/${c.id}/estado`, { estado }))) onCambio();
  };
  const teclas = [c.ivr_tecla_llamada && `${c.ivr_tecla_llamada} = llamada`, c.ivr_tecla_whatsapp && `${c.ivr_tecla_whatsapp} = WhatsApp`].filter(Boolean).join(' · ');

  return (
    <section className="panel">
      <div className="fila separada">
        <div className="pila" style={{ gap: 2 }}>
          <h2 className="panel-titulo"><Link to={`/campanas/${c.id}`}>{c.nombre}</Link></h2>
          <span className="suave chico">
            {c.ivr_destino === 'aviso' ? `Aviso al vendedor · ${teclas || 'sin teclas'}` : 'Pasa la llamada al vendedor'}
            {' · '}{numero(c.restantes)} contactos por llamar{!c.audio_id && ' · falta el audio'}
          </span>
        </div>
        <div className="fila" style={{ gap: 8 }}>
          <span className={`chip ${clase}`}>{texto}</span>
          {puede('campanas.encender') && c.estado !== 'activa' && (
            <button className="primario chico" disabled={ocupado} onClick={() => void cambiarEstado('activa')}>Encender</button>
          )}
          {puede('campanas.encender') && c.estado === 'activa' && (
            <button className="chico" disabled={ocupado} onClick={() => void cambiarEstado('pausada')}>Pausar</button>
          )}
          {puede('ivr.editar') && c.ivr_destino === 'aviso' && c.audio_id && (
            <button className="chico" onClick={() => setProbar(true)}>Probar llamada</button>
          )}
          <Link to={`/campanas/${c.id}`}><button className="chico">Configurar</button></Link>
        </div>
      </div>
      <MensajeError mensaje={error} />
      <div className="kpis">
        <div className="kpi"><strong className="numero">{numero(h?.intentos)}</strong><span>Llamadas</span></div>
        <div className="kpi"><strong className="numero">{numero(h?.atendidas)}</strong><span>Atendieron</span></div>
        <div className="kpi"><strong className="numero">{numero(h?.contestadores)}</strong><span>Contestadores</span></div>
        <div className="kpi"><strong className="numero">{numero(h?.cortaron)}</strong><span>Cortaron en el mensaje</span></div>
        <div className="kpi"><strong className="numero">{numero(h?.sin_marcar)}</strong><span>No marcaron</span></div>
        {c.ivr_destino === 'aviso' && <>
          <div className="kpi bueno"><strong className="numero">{numero(c.avisos_hoy.llamada)}</strong><span>📞 Llamada</span></div>
          <div className="kpi bueno"><strong className="numero">{numero(c.avisos_hoy.whatsapp)}</strong><span>💬 WhatsApp</span></div>
        </>}
        {(h?.no_llame ?? 0) > 0 && <div className="kpi"><strong className="numero">{numero(h?.no_llame)}</strong><span>Pidieron No Llame</span></div>}
      </div>
      {c.turno && (
        <div className="pila" style={{ gap: 6 }}>
          <span className="suave chico">Turno de los avisos (en este orden, y vuelve a empezar):</span>
          {c.turno.vendedores.length === 0 ? (
            <div className="alerta">Ningún vendedor recibe los avisos: asigná vendedores con "Recibe IVR" en la pestaña Vendedores de la campaña.</div>
          ) : (
            <div className="fila" style={{ gap: 8 }}>
              {c.turno.vendedores.map((v, i) => (
                <span key={v.id} className={`chip ${v.conectado ? 'ok' : ''}`} title={v.conectado ? 'Conectado' : 'Sin conectar'}
                  style={c.turno!.proximo === v.id ? { outline: '1px solid var(--acento)', outlineOffset: 3, borderRadius: 4 } : undefined}>
                  {i + 1}. {v.nombre}{c.turno!.proximo === v.id && ' ← próximo'}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {c.audio_id && c.audio_b_id && (
        <details>
          <summary className="suave chico">Comparar audios A y B ({100 - c.audio_b_pct} % / {c.audio_b_pct} %)</summary>
          <ComparacionAudios campanaId={c.id} audioA={c.audio_id} audioB={c.audio_b_id} pctB={c.audio_b_pct} />
        </details>
      )}
      {probar && <ProbarLlamada c={c} onCerrar={() => setProbar(false)} />}
    </section>
  );
}

interface Prueba {
  id: number;
  telefono: string;
  resultado: string | null;
  amd_estado: string | null;
  tecla_ivr: string | null;
  causa_sip: number | null;
  audio_id: number | null;
  terminada: boolean;
  // Segundos desde que empezó a marcar
  atendio_seg: number | null;
  audio_inicio_seg: number | null;
  audio_fin_seg: number | null;
  duracion_seg: number;
}

const RESULTADO_PRUEBA: Record<string, string> = {
  no_contesta: 'No atendió',
  ocupado: 'Ocupado',
  fallida: 'No se pudo llamar',
  contestador: 'La detección lo tomó como contestador y cortó',
  atendida: 'Se cortó antes del mensaje',
  corto_en_mensaje: 'Se cortó durante el mensaje',
  sin_confirmar: 'Escuchó el mensaje y no marcó',
  aviso_ivr: 'Marcó una tecla',
  no_llame_ivr: 'Pidió No Llame',
};

const AMD: Record<string, string> = {
  HUMAN: 'persona', MACHINE: 'contestador', NOTSURE: 'dudoso (pasa igual)', HANGUP: 'cortó durante la detección',
};

const segundos = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('es-AR', { maximumFractionDigits: 1 })} s`);

/** Llama a un número con el flujo de la campaña y muestra cuánto tarda cada paso. */
function ProbarLlamada({ c, onCerrar }: { c: CampanaIvr; onCerrar: () => void }) {
  const { ocupado, error, ejecutar } = useAccion();
  const [telefono, setTelefono] = useState('');
  const [audio, setAudio] = useState<'a' | 'b'>('a');
  const [llamadaId, setLlamadaId] = useState<number | null>(null);
  const [prueba, setPrueba] = useState<Prueba | null>(null);

  // Consulta el avance cada segundo hasta que la llamada termina
  useEffect(() => {
    if (!llamadaId) return;
    let vigente = true;
    let t: ReturnType<typeof setTimeout>;
    const consultar = async () => {
      try {
        const p = await api.get<Prueba>(`/api/ivr/pruebas/${llamadaId}`);
        if (!vigente) return;
        setPrueba(p);
        if (!p.terminada) t = setTimeout(() => void consultar(), 1000);
      } catch {
        if (vigente) t = setTimeout(() => void consultar(), 2000);
      }
    };
    t = setTimeout(() => void consultar(), 500);
    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [llamadaId]);

  const llamar = async (e: FormEvent) => {
    e.preventDefault();
    setPrueba(null);
    await ejecutar(async () => {
      const r = await api.post<{ llamada_id: number }>(`/api/campanas/${c.id}/probar-ivr`, { telefono, audio });
      setLlamadaId(r.llamada_id);
    });
  };

  const p = prueba;
  const enCurso = llamadaId !== null && !p?.terminada;
  const tecla = p?.tecla_ivr;
  const significado = tecla === c.ivr_tecla_llamada ? 'llamada' : tecla === c.ivr_tecla_whatsapp ? 'WhatsApp' : null;

  return (
    <Modal titulo={`Probar llamada · ${c.nombre}`} onCerrar={onCerrar}>
      <form className="pila" onSubmit={(e) => void llamar(e)}>
        <Campo etiqueta="Número" ayuda="Llama con el mismo flujo de la campaña (detección de contestador, audio y teclas). No le llega el aviso a ningún vendedor ni cuenta en los reportes.">
          <input value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="ej. 2617256360" inputMode="tel" autoFocus />
        </Campo>
        {c.audio_b_id && (
          <Campo etiqueta="Audio">
            <select value={audio} onChange={(e) => setAudio(e.target.value as 'a' | 'b')}>
              <option value="a">Audio A</option>
              <option value="b">Audio B</option>
            </select>
          </Campo>
        )}
        <div className="fila">
          <button type="submit" className="primario" disabled={ocupado || enCurso || !telefono.trim()}>
            {enCurso ? 'Llamando…' : llamadaId ? 'Llamar de nuevo' : 'Llamar'}
          </button>
        </div>
      </form>
      <MensajeError mensaje={error} />

      {p && (
        <table className="tabla compacta">
          <tbody>
            <tr><td>Empezó a marcar</td><td className="der numero">0 s</td><td /></tr>
            {p.atendio_seg !== null && (
              <tr><td>Atendió</td><td className="der numero">{segundos(p.atendio_seg)}</td><td className="suave chico">sonó {segundos(p.atendio_seg)}</td></tr>
            )}
            {p.amd_estado && (
              <tr><td>Detección de contestador</td><td /><td className="suave chico">{AMD[p.amd_estado] ?? p.amd_estado}</td></tr>
            )}
            {p.audio_inicio_seg !== null && (
              <tr>
                <td><strong>Arrancó el mensaje</strong>{c.audio_b_id && p.audio_id && ` (audio ${p.audio_id === c.audio_b_id ? 'B' : 'A'})`}</td>
                <td className="der numero">{segundos(p.audio_inicio_seg)}</td>
                <td><strong>{segundos(p.atendio_seg === null ? null : p.audio_inicio_seg - p.atendio_seg)} después de atender</strong></td>
              </tr>
            )}
            {p.audio_fin_seg !== null && (
              <tr><td>{tecla ? 'Marcó (o terminó el mensaje)' : 'Terminó el mensaje'}</td><td className="der numero">{segundos(p.audio_fin_seg)}</td><td /></tr>
            )}
            <tr>
              <td>{p.terminada ? 'Cortó' : 'En curso'}</td>
              <td className="der numero">{segundos(p.duracion_seg)}</td>
              <td>
                {p.terminada
                  ? <>{RESULTADO_PRUEBA[p.resultado ?? ''] ?? p.resultado}{tecla && `: ${tecla}${significado ? ` = ${significado}` : ' (no es una tecla de la campaña)'}`}</>
                  : <span className="suave chico">actualizando…</span>}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </Modal>
  );
}
