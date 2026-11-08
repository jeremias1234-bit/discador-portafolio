// Monitor en vivo (§10): vendedores con su estado y espera, gateways con ocupación y contestación,
// llamadas en curso, decisiones del motor y alertas. Llega por WebSocket una vez por segundo.
// Desde acá el supervisor escucha, susurra o interviene (con su propia línea abierta).
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Link } from 'react-router-dom';
import { BarraTelefono } from '../componentes/BarraTelefono';
import { nivelActual } from '../componentes/Rendimiento';
import { MensajeError, numero, useAccion, useDatos } from '../componentes/ui';
import { useSesion, useYo } from '../sesion';
import { useTiempoReal } from '../tiempoReal';
import type { EstadoPuesto, MotivoDescanso } from '../tipos';
import { duracion } from '../utilidades';

interface PuestoVivo {
  usuario_id: number; nombre: string; interno: string; rol: string; estado: EstadoPuesto;
  motivo_descanso_id: number | null; desde: number; llamada_id: number | null; telefono: string | null;
  segundos_libre: number | null; espia: { modo: Modo; vendedor_id: number } | null;
}
interface LlamadaViva {
  id: number; fase: string; telefono: string; origen: string; campana: string | null; gateway_id: number | null;
  vendedor_id: number | null; segundos: number; segundos_en_cola: number | null;
}
interface GatewayVivo {
  id: number; nombre: string; canales: number; reservados_manual: number; en_uso: number; en_uso_discador: number;
  libres: number; ocupacion_pct: number; estado: string; hoy: { intentos: number; contestacion_pct: number } | null;
}
interface Decision {
  campana_id: number; campana: string; tipo: string; marcando: boolean; motivo: string; vendedores_libres: number;
  en_vuelo: number; activas: number; objetivo: number; abandono_pct: number | null; abandono_objetivo_pct: number; factor: number;
}
interface Kpis { intentos: number; atendidas: number; personas: number; llegaron_al_vendedor: number; abandonos: number; contestadores: number }
interface DatosMonitor {
  ts: number; puestos: PuestoVivo[]; llamadas: LlamadaViva[]; gateways: GatewayVivo[];
  decisiones: Decision[]; kpis_15_min: Kpis | null; alertas: string[];
  espera_hoy: Record<number, { promedio_seg: number | null; atendidas: number }>;
  espera_objetivo: { min_seg: number; max_seg: number };
}
type Modo = 'escuchar' | 'susurrar' | 'intervenir';

const ESTADO: Record<EstadoPuesto, [string, string]> = {
  disponible: ['Disponible', 'ok'], en_llamada: ['En llamada', 'info'], tipificando: ['Tipificando', 'aviso'], descanso: ['Descanso', ''],
};
const FASE: Record<string, string> = {
  marcando: 'Marcando', amd: 'Detectando contestador', audio: 'Escuchando el mensaje',
  espera_tecla: 'Esperando la tecla', permanencia: 'Esperando en línea', despedida: 'Despedida (aviso)', cola: 'En cola', conversacion: 'Con vendedor',
};
/** Espera contra el objetivo (5-60 s por defecto): es una guía, solo se marca. */
function Espera({ seg, objetivo }: { seg: number | null; objetivo: DatosMonitor['espera_objetivo'] }) {
  if (seg === null) return <span className="suave">—</span>;
  const clase = seg > objetivo.max_seg ? 'peligro' : seg < objetivo.min_seg ? '' : 'ok';
  const texto = seg > objetivo.max_seg ? 'Más de lo ideal' : seg < objetivo.min_seg ? 'Recién' : 'En el objetivo';
  return <span className={`chip ${clase} numero`} title={`${texto} (${objetivo.min_seg}–${objetivo.max_seg} s)`}>{duracion(seg)}</span>;
}

const MODO: Record<Modo, string> = { escuchar: 'Escuchando', susurrar: 'Susurrando', intervenir: 'Interviniendo' };

export function Monitor() {
  const yo = useYo();
  const { puede } = useSesion();
  const { suscribir } = useTiempoReal();
  const [m, setM] = useState<DatosMonitor | null>(null);
  const { datos: motivos } = useDatos<MotivoDescanso[]>('/api/motivos-descanso?incluir_inactivos=true');
  const { datos: config } = useDatos<{ clave: string; valor: unknown }[]>('/api/configuracion');
  const limite = config?.find((p) => p.clave === 'ritmo.limite_por_minuto')?.valor as number | undefined;
  const nivel = nivelActual(limite);
  const accion = useAccion();

  // Primera foto por HTTP (sin esperar al WebSocket) y después en vivo
  useEffect(() => {
    void api.get<DatosMonitor>('/api/monitor').then(setM).catch(() => {});
    return suscribir('monitor', (msj) => setM(msj as unknown as DatosMonitor));
  }, [suscribir]);

  const vendedores = useMemo(
    () => (m?.puestos ?? []).filter((p) => p.rol === 'vendedor').sort((a, b) => a.nombre.localeCompare(b.nombre)),
    [m],
  );
  if (!m) return <div className="suave">Conectando con el monitor…</div>;

  const yoPuesto = m.puestos.find((p) => p.usuario_id === yo.id);
  const espiando = yoPuesto?.espia ? m.puestos.find((p) => p.usuario_id === yoPuesto.espia!.vendedor_id) : undefined;
  const puedeSupervisar = puede('supervision.escuchar', 'supervision.susurrar', 'supervision.intervenir');
  const nombreDe = (id: number | null) => (id ? m.puestos.find((p) => p.usuario_id === id)?.nombre ?? `#${id}` : '—');
  const gatewayDe = (id: number | null) => (id ? m.gateways.find((g) => g.id === id)?.nombre ?? `#${id}` : '—');
  const motivoDe = (id: number | null) => motivos?.find((x) => x.id === id)?.nombre;
  const cuenta = (e: EstadoPuesto) => vendedores.filter((v) => v.estado === e).length;
  const ahora = m.ts;

  const supervisar = (vendedorId: number, modo: Modo) =>
    accion.ejecutar(() => api.post('/api/supervision/escuchar', { vendedor_id: vendedorId, modo }));
  const dejar = () => accion.ejecutar(() => api.post('/api/supervision/dejar'));

  const k = m.kpis_15_min;
  const obj = m.espera_objetivo;
  const libres = vendedores.filter((v) => v.segundos_libre !== null);
  const esperaActual = libres.length ? Math.round(libres.reduce((t, v) => t + v.segundos_libre!, 0) / libres.length) : null;
  const conPromedio = vendedores.map((v) => m.espera_hoy[v.usuario_id]?.promedio_seg).filter((x): x is number => x != null);
  const esperaHoy = conPromedio.length ? Math.round(conPromedio.reduce((t, x) => t + x, 0) / conPromedio.length) : null;
  const pasados = libres.filter((v) => v.segundos_libre! > obj.max_seg).length;

  const abandonoPct = k && k.llegaron_al_vendedor + k.abandonos > 0 ? Math.round((1000 * k.abandonos) / (k.llegaron_al_vendedor + k.abandonos)) / 10 : 0;
  const enCola = m.llamadas.filter((l) => l.fase === 'cola').length;
  const disponibles = cuenta('disponible');

  return (
    <div className="pila monitor" style={{ gap: 14 }}>
      <div className="fila separada">
        <div className="fila">
          <h1>Monitor</h1>
          {limite !== undefined && (
            <span className="chip" title="Se cambia en Configuración → Rendimiento">
              {nivel ? `${nivel.nombre} · ${numero(nivel.porHora)} llamadas/h` : `${numero(limite * 60)} llamadas/h`}
            </span>
          )}
        </div>
        {puedeSupervisar && (
          <div className="fila linea-supervisor">
            {espiando && (
              <>
                <span className="chip info">{MODO[yoPuesto!.espia!.modo]} a {espiando.nombre}</span>
                <button className="peligro" onClick={() => void dejar()} disabled={accion.ocupado}>Dejar de escuchar</button>
              </>
            )}
            {/* El admin abre su línea en "Llamar" (queda abierta para escuchar desde acá) */}
            {yo.rol === 'admin'
              ? !yoPuesto && <span className="suave chico">Para escuchar, abrí tu línea en <Link to="/puesto">Llamar</Link>.</span>
              : <BarraTelefono lineaEnServidor={!!yoPuesto} interno={yo.interno_sip} />}
          </div>
        )}
      </div>
      <MensajeError mensaje={accion.error} />

      <div className="kpis">
        <div className={`kpi ${abandonoPct > (m.decisiones[0]?.abandono_objetivo_pct ?? 3) ? 'malo' : 'bueno'}`}><strong className="numero">{abandonoPct}%</strong><span>Abandono (15 min)</span></div>
        <div className={`kpi ${enCola ? 'atencion' : ''}`}><strong className="numero">{enCola}</strong><span>Esperando ahora</span></div>
        <div className="kpi"><strong className="numero">{esperaActual === null ? '—' : duracion(esperaActual)}</strong><span>Espera actual prom.</span></div>
        <div className="kpi"><strong className="numero">{esperaHoy === null ? '—' : duracion(esperaHoy)}</strong><span>Espera entre llamadas hoy</span></div>
        <div className={`kpi ${pasados ? 'malo' : ''}`}><strong className="numero">{pasados}</strong><span>Más de {obj.max_seg} s sin llamada</span></div>
        <div className="kpi"><strong className="numero">{m.llamadas.length}</strong><span>Llamadas en curso</span></div>
        <div className="kpi"><strong className="numero">{k ? numero(k.intentos) : '—'}</strong><span>Intentos (15 min)</span></div>
        <div className="kpi"><strong className="numero">{k ? numero(k.llegaron_al_vendedor) : '—'}</strong><span>Al vendedor (15 min)</span></div>
      </div>

      {m.alertas.length > 0 && (
        <div className="alertas">{m.alertas.map((a) => <span key={a} className="alerta">{a}</span>)}</div>
      )}

      <div className="monitor-grilla">
        <section className="panel">
          <h2 className="panel-titulo">Vendedores · {disponibles} libres de {vendedores.length}
            <span className="suave chico"> · objetivo de espera {obj.min_seg}–{obj.max_seg} s</span></h2>
          <div className="tabla-envoltura">
            <table className="tabla compacta">
              <thead>
                <tr><th>Vendedor</th><th>Interno</th><th>Estado</th><th className="der">Tiempo</th><th className="der">Llam.</th><th>Esperando</th><th>Espera prom.</th><th>Con</th>{puedeSupervisar && <th></th>}</tr>
              </thead>
              <tbody>
                {vendedores.map((v) => {
                  const [texto, clase] = ESTADO[v.estado];
                  const motivo = v.estado === 'descanso' ? motivoDe(v.motivo_descanso_id) : undefined;
                  const loEscucho = yoPuesto?.espia?.vendedor_id === v.usuario_id;
                  const hoy = m.espera_hoy[v.usuario_id];
                  return (
                    <tr key={v.usuario_id} className={loEscucho ? 'resaltado' : ''}>
                      <td><strong>{v.nombre}</strong></td>
                      <td className="numero">{v.interno}</td>
                      <td><span className={`chip ${clase}`}>{texto}{motivo ? ` · ${motivo}` : ''}</span></td>
                      <td className="der numero">{duracion((ahora - v.desde) / 1000)}</td>
                      <td className="der numero">{hoy?.atendidas ?? 0}</td>
                      <td><Espera seg={v.segundos_libre} objetivo={obj} /></td>
                      <td><Espera seg={hoy?.promedio_seg ?? null} objetivo={obj} /></td>
                      <td className="numero">{v.telefono ?? '—'}</td>
                      {puedeSupervisar && (
                        <td>
                          <div className="fila" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end', gap: 4 }}>
                            {(['escuchar', 'susurrar', 'intervenir'] as Modo[]).filter((x) => puede(`supervision.${x}`)).map((x) => (
                              <button key={x} className={`chico ${loEscucho && yoPuesto?.espia?.modo === x ? 'seleccionado' : ''}`}
                                onClick={() => void supervisar(v.usuario_id, x)} disabled={accion.ocupado || !yoPuesto}
                                title={yoPuesto ? undefined : yo.rol === 'admin' ? 'Primero abrí tu línea en Llamar' : 'Primero conectá tu línea (arriba a la derecha)'}>
                                {x === 'escuchar' ? 'Escuchar' : x === 'susurrar' ? 'Susurrar' : 'Intervenir'}
                              </button>
                            ))}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {vendedores.length === 0 && <tr><td colSpan={9} className="vacio">Ningún vendedor conectado. El sistema no llama a nadie.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <h2 className="panel-titulo">Gateways</h2>
          <div className="pila" style={{ gap: 12 }}>
            {m.gateways.map((g) => {
              const online = g.estado === 'online';
              return (
                <div key={g.id} className="gw">
                  <div className="fila separada">
                    <strong>{g.nombre} {!online && <span className="chip peligro">{g.estado === 'offline' ? 'sin conexión' : g.estado}</span>}</strong>
                    <span className="numero suave">{g.en_uso}/{g.canales} puertos</span>
                  </div>
                  <div className="medidor" title={`${g.ocupacion_pct}% en uso · ${g.en_uso_discador} del discador, ${g.en_uso - g.en_uso_discador} manuales · ${g.reservados_manual} reservados para manual`}>
                    <div style={{ width: `${Math.min(100, g.ocupacion_pct)}%` }} />
                    {g.reservados_manual > 0 && <i style={{ left: `${((g.canales - g.reservados_manual) / g.canales) * 100}%` }} />}
                  </div>
                  <div className="suave chico">
                    {g.hoy && g.hoy.intentos > 0 ? `${numero(g.hoy.intentos)} llamadas hoy · ${g.hoy.contestacion_pct}% contestadas · ${g.ocupacion_pct}% en uso` : 'sin llamadas todavía'}
                  </div>
                </div>
              );
            })}
            {m.gateways.length === 0 && <div className="vacio">No hay gateways activos.</div>}
          </div>
        </section>
      </div>

      <section className="panel">
        <h2 className="panel-titulo">Campañas activas · {m.decisiones.length}</h2>
        <div className="tabla-envoltura">
          <table className="tabla compacta">
            <thead><tr><th>Campaña</th><th>Motor</th><th className="der">Vendedores libres</th><th className="der">Marcando</th><th className="der">Activas</th><th className="der">Objetivo</th><th className="der">Abandono</th></tr></thead>
            <tbody>
              {m.decisiones.map((d) => (
                <tr key={d.campana_id}>
                  <td><strong>{d.campana}</strong></td>
                  <td><span className={`chip ${d.marcando ? 'ok' : 'aviso'}`}>{d.motivo}</span></td>
                  <td className="der numero">{d.vendedores_libres}</td>
                  <td className="der numero">{d.en_vuelo}</td>
                  <td className="der numero">{d.activas}</td>
                  <td className="der numero">{d.objetivo === -1 ? 'todos' : d.objetivo}</td>
                  <td className="der numero">{d.abandono_pct === null ? '—' : `${d.abandono_pct}%`} <span className="suave chico">/ {d.abandono_objetivo_pct}%</span></td>
                </tr>
              ))}
              {m.decisiones.length === 0 && <tr><td colSpan={7} className="vacio">No hay campañas activas.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-titulo">Llamadas en curso · {m.llamadas.length}</h2>
        <div className="tabla-envoltura">
          <table className="tabla compacta">
            <thead><tr><th>Teléfono</th><th>Estado</th><th>Campaña</th><th>Gateway</th><th>Vendedor</th><th className="der">Duración</th></tr></thead>
            <tbody>
              {[...m.llamadas].sort((a, b) => b.segundos - a.segundos).map((l) => (
                <tr key={l.id}>
                  <td className="numero">{l.telefono}</td>
                  <td>{FASE[l.fase] ?? l.fase}{l.segundos_en_cola !== null ? ` · ${l.segundos_en_cola} s` : ''}</td>
                  <td>{l.campana ?? (l.origen === 'manual' ? 'Manual' : '—')}</td>
                  <td>{gatewayDe(l.gateway_id)}</td>
                  <td>{nombreDe(l.vendedor_id)}</td>
                  <td className="der numero">{duracion(l.segundos)}</td>
                </tr>
              ))}
              {m.llamadas.length === 0 && <tr><td colSpan={6} className="vacio">Sin llamadas.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
