// Detalle de una campaña: estado y checklist, parámetros, bases, vendedores y gateways.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ComparacionAudios } from '../componentes/ComparacionAudios';
import { Campo, fechaHora, Interruptor, MensajeError, Modal, numero, Pestanas, useAccion, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import { SubirAudio } from './Audios';
import { BarraAvance, ESTADO_CAMPANA, NOMBRE_TIPO, TIPOS, type Avance, type EstadoCampana, type TipoCampana } from './Campanas';

interface Campana extends Avance {
  id: number;
  nombre: string;
  tipo: TipoCampana;
  estado: EstadoCampana;
  prioridad: number;
  hora_inicio: string;
  hora_fin: string;
  dias_semana: number[];
  max_intentos: number;
  minutos_reintento: number;
  segundos_timbre: number;
  todos_los_gateways: boolean;
  tope_canales: number | null;
  llamadas_por_vendedor: number | null;
  puertos_por_vendedor_auto: boolean;
  abandono_objetivo_pct: number | null;
  amd_activo: boolean;
  grabar: boolean;
  audio_id: number | null;
  audio_b_id: number | null;
  audio_b_pct: number;
  ivr_modo: 'presione_1' | 'permanencia' | 'cualquiera';
  ivr_tecla_pase: string;
  ivr_tecla_no_llame: string | null;
  ivr_espera_seg: number;
  ivr_repeticiones: number;
  ivr_destino: 'vendedor' | 'aviso';
  ivr_tecla_llamada: string | null;
  ivr_tecla_whatsapp: string | null;
  ivr_audio_despedida_id: number | null;
  espera_max_seg: number;
  ivr_canales: number | null;
  llamadas_por_segundo: number | null;
  vendedores: { id: number; nombre: string; usuario: string; interno_sip: string | null; activo: boolean; recibe_ivr: boolean }[];
  gateways: { id: number; nombre: string; canales: number; activo: boolean }[];
}

type Pestana = 'resumen' | 'config' | 'bases' | 'vendedores' | 'gateways';
const CON_AUDIO: TipoCampana[] = ['predictivo_audio', 'ivr'];

export function CampanaDetalle() {
  const id = Number(useParams().id);
  const { datos: c, error, recargar } = useDatos<Campana>(`/api/campanas/${id}`);
  const [pestana, setPestana] = useState<Pestana>('resumen');

  if (!c) return error ? <MensajeError mensaje={error} /> : <div className="suave">Cargando…</div>;
  const [texto, clase] = ESTADO_CAMPANA[c.estado];
  const opciones: [Pestana, string][] = [
    ['resumen', 'Resumen'], ['config', 'Configuración'], ['bases', `Bases (${numero(c.leads_total)})`],
    ['vendedores', `Vendedores (${c.vendedores.length})`], ['gateways', 'Gateways'],
  ];

  return (
    <>
      <div className="fila separada encabezado">
        <div className="pila" style={{ gap: 4 }}>
          <Link to="/campanas" className="chico">← Campañas</Link>
          <div className="fila">
            <h1>{c.nombre}</h1>
            <span className="chip info">{NOMBRE_TIPO[c.tipo]}</span>
            <span className={`chip ${clase}`}>{texto}</span>
          </div>
        </div>
      </div>
      <Pestanas opciones={opciones} actual={pestana} onCambiar={setPestana} />
      {pestana === 'resumen' && <Resumen c={c} onCambio={() => void recargar()} />}
      {pestana === 'config' && <Configuracion c={c} onGuardado={() => void recargar()} />}
      {pestana === 'bases' && <Bases c={c} onCambio={() => void recargar()} />}
      {pestana === 'vendedores' && <Vendedores c={c} onGuardado={() => void recargar()} />}
      {pestana === 'gateways' && <Gateways c={c} onGuardado={() => void recargar()} />}
    </>
  );
}

// ---------------------------------------------------------------- Resumen

interface ItemChecklist { clave: string; ok: boolean; obligatorio: boolean; detalle: string }
const NOMBRE_ITEM: Record<string, string> = {
  base: 'Base', vendedores: 'Vendedores', no_llame: 'Padrón No Llame', horario: 'Horario', amd: 'AMD',
  gateways: 'Gateways', motor: 'Motor', audio: 'Audio',
};

function Resumen({ c, onCambio }: { c: Campana; onCambio: () => void }) {
  const { puede } = useSesion();
  const { datos: checklist, recargar } = useDatos<{ listo: boolean; items: ItemChecklist[] }>(`/api/campanas/${c.id}/checklist`);
  const { ocupado, error, ejecutar } = useAccion();

  // El checklist cambia con la operación (vendedores que se conectan, el motor): se refresca solo
  useEffect(() => {
    const t = setInterval(() => void recargar(), 5000);
    return () => clearInterval(t);
  }, [recargar]);

  const estado = async (e: EstadoCampana, pregunta?: string) => {
    if (pregunta && !confirm(pregunta)) return;
    if (await ejecutar(() => api.post(`/api/campanas/${c.id}/estado`, { estado: e }))) {
      onCambio();
      void recargar();
    }
  };

  const cifras: [string, number][] = [
    ['Contactos', c.leads_total], ['Sin llamar', c.leads_sin_llamar], ['Para reintentar', c.leads_reintentar],
    ['En curso', c.leads_en_curso], ['Cerrados', c.leads_finalizados], ['Agotados', c.leads_agotados], ['No llamar', c.leads_no_llamar],
  ];

  return (
    <div className="pila" style={{ gap: 16 }}>
      <section className="tarjeta">
        <div className="fila">
          {puede('campanas.encender') && c.estado !== 'archivada' && (
            c.estado === 'activa'
              ? <button className="grande" onClick={() => void estado('pausada')} disabled={ocupado}>Pausar</button>
              : <button className="ok grande" onClick={() => void estado('activa')} disabled={ocupado}>Encender</button>
          )}
          {puede('campanas.encender') && c.estado !== 'terminada' && c.estado !== 'archivada' && (
            <button onClick={() => void estado('terminada', '¿Terminar la campaña? Deja de marcar hasta que la vuelvas a encender.')} disabled={ocupado}>Terminar</button>
          )}
          {puede('campanas.archivar') && (
            c.estado === 'archivada'
              ? <button onClick={() => void estado('pausada')} disabled={ocupado}>Desarchivar</button>
              : c.estado !== 'activa' && <button onClick={() => void estado('archivada', '¿Archivar la campaña? Se oculta de la lista.')} disabled={ocupado}>Archivar</button>
          )}
        </div>
        <MensajeError mensaje={error} />
      </section>

      <section className="tarjeta">
        <div className="fila separada">
          <h2>Listo para arrancar</h2>
          {checklist && (checklist.listo ? <span className="chip ok">Todo en orden</span> : <span className="chip aviso">Falta algo</span>)}
        </div>
        <ul className="lista">
          {(checklist?.items ?? []).map((i) => (
            <li key={i.clave}>
              <div className="fila">
                <span className={`chip ${i.ok ? 'ok' : i.obligatorio ? 'peligro' : 'aviso'}`}>{i.ok ? 'OK' : i.obligatorio ? 'Falta' : 'Ojo'}</span>
                <strong>{NOMBRE_ITEM[i.clave] ?? i.clave}</strong>
              </div>
              <span className="suave">{i.detalle}</span>
            </li>
          ))}
        </ul>
      </section>

      {CON_AUDIO.includes(c.tipo) && c.audio_id && (
        <section className="tarjeta">
          <h2>Audios</h2>
          <ComparacionAudios campanaId={c.id} audioA={c.audio_id} audioB={c.audio_b_id} pctB={c.audio_b_pct} />
        </section>
      )}

      <section className="tarjeta">
        <h2>Avance de la base</h2>
        <BarraAvance a={c} />
        <div className="rejilla">
          {cifras.map(([t, n]) => (
            <div key={t}>
              <div className="suave chico">{t}</div>
              <div className="numero" style={{ fontSize: 22, fontWeight: 700 }}>{numero(n)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Configuración

const DIAS: [number, string][] = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [7, 'Dom']];
const EDITABLES = [
  'nombre', 'tipo', 'prioridad', 'hora_inicio', 'hora_fin', 'dias_semana', 'max_intentos', 'minutos_reintento',
  'segundos_timbre', 'tope_canales', 'llamadas_por_vendedor', 'puertos_por_vendedor_auto', 'abandono_objetivo_pct', 'amd_activo', 'grabar',
  'audio_id', 'audio_b_id', 'audio_b_pct', 'ivr_modo', 'ivr_tecla_pase', 'ivr_tecla_no_llame', 'ivr_espera_seg', 'ivr_repeticiones',
  'ivr_destino', 'ivr_tecla_llamada', 'ivr_tecla_whatsapp', 'ivr_audio_despedida_id', 'espera_max_seg', 'ivr_canales', 'llamadas_por_segundo',
] as const;
type Editable = Pick<Campana, (typeof EDITABLES)[number]>;

function Configuracion({ c, onGuardado }: { c: Campana; onGuardado: () => void }) {
  const { puede } = useSesion();
  const inicial = useMemo(() => Object.fromEntries(EDITABLES.map((k) => [k, c[k]])) as Editable, [c]);
  const [f, setF] = useState<Editable>(inicial);
  const { datos: audios, recargar: recargarAudios } = useDatos<{ id: number; nombre: string; duracion_seg: number | null }[]>('/api/audios');
  const [subiendoAudio, setSubiendoAudio] = useState(false);
  const { datos: gateways } = useDatos<{ id: number; canales: number; canales_reservados_manual: number; activo: boolean }[]>('/api/gateways');
  const { ocupado, error, ejecutar } = useAccion();
  const [guardado, setGuardado] = useState(false);
  const editable = puede(f.tipo === 'ivr' ? 'ivr.editar' : 'campanas.editar') && c.estado !== 'archivada';

  useEffect(() => setF(inicial), [inicial]);
  const cambiar = <K extends keyof Editable>(k: K, v: Editable[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setGuardado(false);
  };
  const num = (k: keyof Editable, nulo = false) => ({
    value: (f[k] as number | null) ?? '',
    onChange: (e: { target: { value: string } }) => cambiar(k, (e.target.value === '' ? (nulo ? null : 0) : Number(e.target.value)) as never),
  });

  const cambios = Object.fromEntries(EDITABLES.filter((k) => JSON.stringify(f[k]) !== JSON.stringify(inicial[k])).map((k) => [k, f[k]]));
  const hayCambios = Object.keys(cambios).length > 0;
  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (await ejecutar(() => api.patch(`/api/campanas/${c.id}`, cambios))) {
      setGuardado(true);
      onGuardado();
    }
  };
  const predictivo = f.tipo === 'predictivo' || f.tipo === 'predictivo_audio';
  const conAudio = CON_AUDIO.includes(f.tipo);

  return (
    <form className="tarjeta" onSubmit={guardar} style={{ gap: 16 }}>
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 16 }}>
        <div className="seccion">
          <h3>General</h3>
          <div className="rejilla">
            <Campo etiqueta="Nombre"><input value={f.nombre} onChange={(e) => cambiar('nombre', e.target.value)} required /></Campo>
            <Campo etiqueta="Tipo">
              <select value={f.tipo} onChange={(e) => cambiar('tipo', e.target.value as TipoCampana)}>
                {TIPOS.map(([t, n]) => <option key={t} value={t}>{n}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Prioridad" ayuda="Mayor = se atiende primero (-100 a 100)."><input type="number" min={-100} max={100} {...num('prioridad')} /></Campo>
          </div>
        </div>

        <div className="seccion">
          <h3>Horario</h3>
          <div className="rejilla">
            <Campo etiqueta="Desde"><input type="time" value={f.hora_inicio} onChange={(e) => cambiar('hora_inicio', e.target.value)} required /></Campo>
            <Campo etiqueta="Hasta"><input type="time" value={f.hora_fin} onChange={(e) => cambiar('hora_fin', e.target.value)} required /></Campo>
          </div>
          <div className="dias">
            {DIAS.map(([d, n]) => {
              const activo = f.dias_semana.includes(d);
              return (
                <button type="button" key={d} className={activo ? 'seleccionado' : ''}
                  onClick={() => cambiar('dias_semana', activo ? f.dias_semana.filter((x) => x !== d) : [...f.dias_semana, d].sort())}>
                  {n}
                </button>
              );
            })}
          </div>
          <small className="suave chico">Además rige el horario global y los bloqueos (feriados).</small>
        </div>

        {f.tipo !== 'manual' && (
          <div className="seccion">
            <h3>Marcación</h3>
            <div className="rejilla">
              <Campo etiqueta="Intentos por contacto"><input type="number" min={1} max={50} {...num('max_intentos')} /></Campo>
              <Campo etiqueta="Minutos entre intentos"><input type="number" min={1} max={10080} {...num('minutos_reintento')} /></Campo>
              <Campo etiqueta="Segundos de timbre" ayuda="Pasado este tiempo, 'no contesta'."><input type="number" min={5} max={120} {...num('segundos_timbre')} /></Campo>
              <Campo etiqueta="Tope de canales" ayuda="Vacío = sin tope."><input type="number" min={1} {...num('tope_canales', true)} /></Campo>
              <Campo etiqueta="Llamadas por segundo" ayuda="Vacío = lo del gateway."><input type="number" min={0.1} step={0.1} {...num('llamadas_por_segundo', true)} /></Campo>
              {predictivo && <Campo etiqueta="Abandono objetivo (%)" ayuda="Vacío = valor global."><input type="number" min={0} max={100} step={0.5} {...num('abandono_objetivo_pct', true)} /></Campo>}
              {conAudio && <Campo etiqueta="Espera máxima en cola (s)" ayuda="Sin vendedor libre: música y después abandono."><input type="number" min={0} max={600} {...num('espera_max_seg')} /></Campo>}
            </div>
            {predictivo && (() => {
              // Puertos de la campaña (sin los reservados para manual) entre sus vendedores
              const propios = (gateways ?? []).filter((g) => g.activo && (c.todos_los_gateways || c.gateways.some((x) => x.id === g.id)));
              const puertos = propios.reduce((t, g) => t + Math.max(0, g.canales - g.canales_reservados_manual), 0);
              const vendedores = c.vendedores.length;
              const reparto = vendedores ? Math.max(1, Math.floor(puertos / vendedores)) : null;
              return (
                <div className="opciones-puertos">
                  <span className="suave chico">Puertos por vendedor: máximo de llamadas simultáneas por cada vendedor libre</span>
                  <label className="interruptor">
                    <input type="radio" name="puertos" checked={f.puertos_por_vendedor_auto} onChange={() => cambiar('puertos_por_vendedor_auto', true)} />
                    <div>
                      <div>Automático: repartir los puertos entre los vendedores</div>
                      <small className="suave chico">
                        {puertos} puertos ÷ {vendedores} vendedores asignados = {reparto ?? '—'} por vendedor. Se recalcula con los que tienen la línea conectada.
                      </small>
                    </div>
                  </label>
                  <label className="interruptor">
                    <input type="radio" name="puertos" checked={!f.puertos_por_vendedor_auto} onChange={() => cambiar('puertos_por_vendedor_auto', false)} />
                    <div className="fila" style={{ gap: 8 }}>
                      <span>Fijo:</span>
                      <input type="number" min={1} max={20} step={1} style={{ width: 80 }} disabled={f.puertos_por_vendedor_auto}
                        value={f.llamadas_por_vendedor ?? ''} placeholder="global"
                        onChange={(e) => cambiar('llamadas_por_vendedor', e.target.value ? Number(e.target.value) : null)} />
                      <span className="suave chico">por vendedor (vacío = el valor global)</span>
                    </div>
                  </label>
                </div>
              );
            })()}
            <Interruptor etiqueta="Detección de contestador (AMD)" ayuda="Los contestadores se cortan sin pasar al vendedor." valor={f.amd_activo} onCambiar={(v) => cambiar('amd_activo', v)} />
          </div>
        )}
        <Interruptor etiqueta="Grabar las llamadas" valor={f.grabar} onCambiar={(v) => cambiar('grabar', v)} />

        {conAudio && (
          <div className="seccion">
            <h3>Mensaje e IVR</h3>
            <div className="fila" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 260px' }}>
                <Campo etiqueta="Audio que escucha el cliente">
                  <select value={f.audio_id ?? ''} onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : null;
                    cambiar('audio_id', id);
                    if (id && id === f.audio_b_id) cambiar('audio_b_id', null); // el mismo audio no puede ser A y B
                  }}>
                    <option value="">Elegir…</option>
                    {(audios ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}{a.duracion_seg ? ` (${a.duracion_seg.toFixed(1)} s)` : ''}</option>)}
                  </select>
                </Campo>
              </div>
              {puede('ivr.audios') && <button type="button" onClick={() => setSubiendoAudio(true)}>Subir audio nuevo</button>}
              {f.audio_id && <audio controls preload="none" src={`/api/audios/${f.audio_id}/archivo`} style={{ height: 36 }} />}
            </div>
            <div className="fila" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 260px' }}>
                <Campo etiqueta="Audio B (opcional)" ayuda="Para comparar dos mensajes en la misma campaña: cada llamada escucha uno u otro.">
                  <select value={f.audio_b_id ?? ''} onChange={(e) => cambiar('audio_b_id', e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Sin audio B</option>
                    {(audios ?? []).filter((a) => a.id !== f.audio_id).map((a) => <option key={a.id} value={a.id}>{a.nombre}{a.duracion_seg ? ` (${a.duracion_seg.toFixed(1)} s)` : ''}</option>)}
                  </select>
                </Campo>
              </div>
              {f.audio_b_id && <audio controls preload="none" src={`/api/audios/${f.audio_b_id}/archivo`} style={{ height: 36 }} />}
            </div>
            {f.audio_b_id && (
              <div className="pila" style={{ gap: 6 }}>
                <span className="suave chico">Reparto entre los dos audios (se alterna parejo y se puede cambiar con la campaña andando)</span>
                <div className="fila" style={{ gap: 12 }}>
                  <strong>A {100 - f.audio_b_pct} %</strong>
                  <input type="range" min={0} max={100} step={10} value={f.audio_b_pct} style={{ flex: '1 1 200px' }}
                    onChange={(e) => cambiar('audio_b_pct', Number(e.target.value))} />
                  <strong>B {f.audio_b_pct} %</strong>
                  <input type="number" min={0} max={100} style={{ width: 70 }} {...num('audio_b_pct')} />
                </div>
                <small className="suave chico">
                  {f.audio_b_pct % 10 === 0
                    ? `De cada 10 llamadas que escuchan el mensaje: ${(100 - f.audio_b_pct) / 10} con el A y ${f.audio_b_pct / 10} con el B.`
                    : `De cada 100 llamadas que escuchan el mensaje: ${100 - f.audio_b_pct} con el A y ${f.audio_b_pct} con el B.`}
                </small>
              </div>
            )}

            {f.tipo === 'ivr' && (
              <div className="pila">
                <span className="suave chico">¿Qué pasa cuando el cliente responde?</span>
                {([
                  ['aviso', 'Aviso al vendedor (llamada o WhatsApp)', 'Ej.: "…marcá 1 para que te llamemos o 2 para que te escribamos por WhatsApp". Se corta la llamada y el número le llega por turno a un vendedor, en la extensión de Chrome.'],
                  ['vendedor', 'Pasa la llamada al vendedor', 'El cliente queda en línea y lo atiende un vendedor libre con la línea abierta.'],
                ] as const).map(([d, t, a]) => (
                  <label key={d} className="interruptor">
                    <input type="radio" name="ivr_destino" checked={f.ivr_destino === d} onChange={() => cambiar('ivr_destino', d)} />
                    <div><div>{t}</div><small className="suave chico">{a}</small></div>
                  </label>
                ))}
              </div>
            )}

            {f.tipo === 'ivr' && f.ivr_destino === 'aviso' ? (
              <div className="rejilla">
                <Campo etiqueta="Tecla para que lo llamen">
                  <select value={f.ivr_tecla_llamada ?? ''} onChange={(e) => cambiar('ivr_tecla_llamada', e.target.value || null)}>
                    <option value="">No usar</option>
                    {TECLAS.filter((t) => t !== f.ivr_tecla_whatsapp && t !== f.ivr_tecla_no_llame).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Tecla para que le escriban por WhatsApp">
                  <select value={f.ivr_tecla_whatsapp ?? ''} onChange={(e) => cambiar('ivr_tecla_whatsapp', e.target.value || null)}>
                    <option value="">No usar</option>
                    {TECLAS.filter((t) => t !== f.ivr_tecla_llamada && t !== f.ivr_tecla_no_llame).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Segundos para marcar después del mensaje" ayuda="Si no marca en este tiempo, se corta.">
                  <input type="number" min={0} max={120} {...num('ivr_espera_seg')} />
                </Campo>
                <Campo etiqueta="Tecla para no recibir más llamadas" ayuda="El número pasa a No Llame.">
                  <select value={f.ivr_tecla_no_llame ?? ''} onChange={(e) => cambiar('ivr_tecla_no_llame', e.target.value || null)}>
                    <option value="">Ninguna</option>
                    {TECLAS.filter((t) => t !== f.ivr_tecla_llamada && t !== f.ivr_tecla_whatsapp && t !== f.ivr_tecla_pase).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Audio de despedida" ayuda='Opcional. Ej.: "Gracias, un asesor te va a contactar". Si no hay, se corta al marcar.'>
                  <select value={f.ivr_audio_despedida_id ?? ''} onChange={(e) => cambiar('ivr_audio_despedida_id', e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Sin despedida</option>
                    {(audios ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}{a.duracion_seg ? ` (${a.duracion_seg.toFixed(1)} s)` : ''}</option>)}
                  </select>
                </Campo>
                <Campo etiqueta="Veces que se repite el mensaje"><input type="number" min={1} max={10} {...num('ivr_repeticiones')} /></Campo>
                <Campo etiqueta="Canales para el IVR" ayuda="Vacío = el tope de canales."><input type="number" min={1} {...num('ivr_canales', true)} /></Campo>
              </div>
            ) : (<>
            <div className="pila">
              <span className="suave chico">¿Cuándo pasa al vendedor?</span>
              {([
                ['presione_1', 'Si marca una tecla', 'Ej.: "…marcá 1 para hablar con un asesor". Si no marca a tiempo, se corta.'],
                ['permanencia', 'Si se queda en línea', 'Ej.: "…aguardá en línea y un asesor te atenderá". Si sigue en línea X segundos después del mensaje, pasa.'],
                ['cualquiera', 'Cualquiera de las dos', 'Pasa apenas marca la tecla, o si se queda en línea los segundos indicados.'],
              ] as const).map(([m, t, d]) => (
                <label key={m} className="interruptor">
                  <input type="radio" name="ivr_modo" checked={f.ivr_modo === m} onChange={() => cambiar('ivr_modo', m)} />
                  <div><div>{t}</div><small className="suave chico">{d}</small></div>
                </label>
              ))}
            </div>

            <div className="rejilla">
              {f.ivr_modo !== 'permanencia' && (
                <Campo etiqueta="Tecla para pasar al vendedor">
                  <select value={f.ivr_tecla_pase} onChange={(e) => cambiar('ivr_tecla_pase', e.target.value)}>
                    {TECLAS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Campo>
              )}
              {f.ivr_modo === 'presione_1' ? (
                <Campo etiqueta="Segundos para marcar después del mensaje" ayuda="Si no marca en este tiempo, se corta.">
                  <input type="number" min={0} max={120} {...num('ivr_espera_seg')} />
                </Campo>
              ) : (
                <Campo etiqueta="Segundos en línea después del mensaje" ayuda="Si sigue en línea este tiempo, pasa al vendedor.">
                  <input type="number" min={0} max={120} {...num('ivr_espera_seg')} />
                </Campo>
              )}
              <Campo etiqueta="Tecla para no recibir más llamadas" ayuda="El número pasa a No Llame.">
                <select value={f.ivr_tecla_no_llame ?? ''} onChange={(e) => cambiar('ivr_tecla_no_llame', e.target.value || null)}>
                  <option value="">Ninguna</option>
                  {TECLAS.filter((t) => t !== f.ivr_tecla_pase).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Veces que se repite el mensaje"><input type="number" min={1} max={10} {...num('ivr_repeticiones')} /></Campo>
              {f.tipo === 'ivr' && <Campo etiqueta="Canales para el IVR" ayuda="Vacío = el tope de canales."><input type="number" min={1} {...num('ivr_canales', true)} /></Campo>}
            </div>
            </>)}
            <div className="alerta info">{resumenIvr(f)}</div>
          </div>
        )}
      </fieldset>
      <MensajeError mensaje={error} />
      {subiendoAudio && (
        <SubirAudio onCerrar={() => setSubiendoAudio(false)}
          onSubido={(a) => { setSubiendoAudio(false); void recargarAudios(); cambiar('audio_id', a.id); }} />
      )}
      {editable && (
        <div className="fila">
          <button className="primario" disabled={ocupado || !hayCambios}>Guardar cambios</button>
          {hayCambios && <button type="button" onClick={() => setF(inicial)}>Descartar</button>}
          {guardado && !hayCambios && <span className="chip ok">Guardado</span>}
        </div>
      )}
    </form>
  );
}

const TECLAS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];

/** El flujo en una frase, para que quien configura vea qué va a pasar. */
function resumenIvr(f: Editable): string {
  if (f.tipo === 'ivr' && f.ivr_destino === 'aviso') {
    const opciones = [
      f.ivr_tecla_llamada && `${f.ivr_tecla_llamada} para que lo llamen`,
      f.ivr_tecla_whatsapp && `${f.ivr_tecla_whatsapp} para WhatsApp`,
      f.ivr_tecla_no_llame && `${f.ivr_tecla_no_llame} para no recibir más llamadas`,
    ].filter(Boolean).join(', ');
    const veces = f.ivr_repeticiones > 1 ? ` (se repite ${f.ivr_repeticiones} veces)` : '';
    return `El cliente atiende y escucha el mensaje${veces}. Tiene ${f.ivr_espera_seg} s para marcar: ${opciones || 'falta elegir las teclas'}. ` +
      `Al marcar ${f.ivr_audio_despedida_id ? 'escucha la despedida y ' : ''}se corta, y el número le llega al próximo vendedor del turno ` +
      '(entre los asignados con "Recibe IVR"), con el tipo de contacto y el nombre del cliente.';
  }
  const pase =
    f.ivr_modo === 'presione_1' ? `si marca ${f.ivr_tecla_pase} (tiene ${f.ivr_espera_seg} s después del mensaje; si no marca, se corta)`
    : f.ivr_modo === 'permanencia' ? `si sigue en línea ${f.ivr_espera_seg} s después del mensaje`
    : `si marca ${f.ivr_tecla_pase} o sigue en línea ${f.ivr_espera_seg} s`;
  const noLlame = f.ivr_tecla_no_llame ? ` Si marca ${f.ivr_tecla_no_llame}, pasa a No Llame.` : '';
  const veces = f.ivr_repeticiones > 1 ? ` (el mensaje se repite ${f.ivr_repeticiones} veces)` : '';
  return `El cliente atiende y escucha el mensaje${veces}. Pasa al vendedor ${pase}.${noLlame} ` +
    `Si no hay vendedor libre, espera con música hasta ${f.espera_max_seg} s y después se corta.`;
}

// ---------------------------------------------------------------- Bases

interface Lista {
  id: number;
  nombre: string;
  archivo_origen: string | null;
  activa: boolean;
  filas_archivo: number;
  cargados: number;
  descartados_no_llame: number;
  descartados_duplicados: number;
  descartados_invalidos: number;
  cargada_en: string;
  sin_llamar: number;
  pendientes: number;
  finalizados: number;
  agotados: number;
  no_llamar: number;
}

interface ResultadoCarga {
  filas_archivo: number;
  cargados: number;
  descartados_no_llame: number;
  descartados_duplicados: number;
  descartados_invalidos: number;
  ejemplos_invalidos: string[];
}

function Bases({ c, onCambio }: { c: Campana; onCambio: () => void }) {
  const { puede } = useSesion();
  const { datos: listas, error, recargar } = useDatos<Lista[]>(`/api/campanas/${c.id}/listas`);
  const [cargar, setCargar] = useState(false);
  const [reciclar, setReciclar] = useState<Lista | null>(null);
  const accion = useAccion();
  const actualizar = () => {
    void recargar();
    onCambio();
  };

  const alternar = (l: Lista) => accion.ejecutar(() => api.patch(`/api/listas/${l.id}`, { activa: !l.activa })).then((ok) => ok && actualizar());
  const borrar = async (l: Lista) => {
    if (!confirm(`¿Borrar la base "${l.nombre}"? Solo se puede si ningún contacto se llamó todavía.`)) return;
    if (await accion.ejecutar(() => api.borrar(`/api/listas/${l.id}`))) actualizar();
  };

  return (
    <div className="pila" style={{ gap: 12 }}>
      {puede('campanas.cargar_bases') && <div><button className="primario" onClick={() => setCargar(true)}>Cargar base (CSV)</button></div>}
      <MensajeError mensaje={error ?? accion.error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead>
            <tr>
              <th>Base</th><th>Cargada</th><th className="der">Cargados</th><th className="der">Descartados</th>
              <th className="der">Sin llamar</th><th className="der">Pendientes</th><th className="der">Cerrados</th><th className="der">Agotados</th><th></th>
            </tr>
          </thead>
          <tbody>
            {(listas ?? []).map((l) => (
              <tr key={l.id} className={l.activa ? '' : 'inactivo'}>
                <td><strong>{l.nombre}</strong><div className="suave chico">{l.archivo_origen}</div></td>
                <td className="suave">{fechaHora(l.cargada_en)}</td>
                <td className="der numero">{numero(l.cargados)}</td>
                <td className="der numero" title={`No Llame ${l.descartados_no_llame} · duplicados ${l.descartados_duplicados} · inválidos ${l.descartados_invalidos}`}>
                  {numero(l.descartados_no_llame + l.descartados_duplicados + l.descartados_invalidos)}
                </td>
                <td className="der numero">{numero(l.sin_llamar)}</td>
                <td className="der numero">{numero(l.pendientes)}</td>
                <td className="der numero">{numero(l.finalizados + l.no_llamar)}</td>
                <td className="der numero">{numero(l.agotados)}</td>
                <td>
                  <div className="fila" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                    {puede('campanas.cargar_bases') && <button onClick={() => void alternar(l)} disabled={accion.ocupado}>{l.activa ? 'Desactivar' : 'Activar'}</button>}
                    {puede('campanas.reciclar_bases') && <button onClick={() => setReciclar(l)}>Reciclar</button>}
                    {puede('campanas.cargar_bases') && <button onClick={() => void borrar(l)} disabled={accion.ocupado} aria-label="Borrar" title="Borrar">✕</button>}
                  </div>
                </td>
              </tr>
            ))}
            {listas?.length === 0 && <tr><td colSpan={9} className="vacio">Esta campaña todavía no tiene bases.</td></tr>}
          </tbody>
        </table>
      </div>
      {cargar && <CargarBase campanaId={c.id} onCerrar={() => setCargar(false)} onCargada={actualizar} />}
      {reciclar && <Reciclar lista={reciclar} onCerrar={() => setReciclar(null)} onHecho={actualizar} />}
    </div>
  );
}

/**
 * Lee la primera fila del CSV en el navegador para ofrecer las columnas. Formato de referencia:
 * teléfono | nombre | DNI | resto. Si la primera fila ya es un dato (empieza con un teléfono),
 * el archivo no tiene encabezados y las columnas se llaman como las nombra el backend.
 */
async function leerEncabezado(archivo: File): Promise<{ columnas: string[]; sinEncabezado: boolean }> {
  const bytes = new Uint8Array(await archivo.slice(0, 64 * 1024).arrayBuffer());
  let texto = new TextDecoder('utf-8').decode(bytes);
  if (texto.includes('\uFFFD')) texto = new TextDecoder('windows-1252').decode(bytes);
  const linea = texto.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? '';
  const separador = [';', ',', '\t', '|'].map((s) => [s, linea.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const celdas = linea.split(separador).map((c) => c.trim().replace(/^"|"$/g, ''));
  const sinEncabezado = (celdas[0] ?? '').replace(/\D/g, '').length >= 8;
  const columnas = sinEncabezado ? celdas.map((_, j) => ['telefono', 'nombre', 'dni'][j] ?? `columna_${j + 1}`) : celdas.filter(Boolean);
  return { columnas, sinEncabezado };
}

function CargarBase({ campanaId, onCerrar, onCargada }: { campanaId: number; onCerrar: () => void; onCargada: () => void }) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [columnas, setColumnas] = useState<string[]>([]);
  const [colTel, setColTel] = useState('');
  const [colNombre, setColNombre] = useState('');
  const [colDni, setColDni] = useState('');
  const [sinEncabezado, setSinEncabezado] = useState(false);
  const [nombre, setNombre] = useState('');
  const [resultado, setResultado] = useState<ResultadoCarga | null>(null);
  const { ocupado, error, setError, ejecutar } = useAccion();

  const elegir = async (a: File | null) => {
    setArchivo(a);
    setResultado(null);
    if (!a) return;
    setNombre(a.name.replace(/\.[^.]+$/, ''));
    try {
      const { columnas: cols, sinEncabezado: sin } = await leerEncabezado(a);
      setColumnas(cols);
      setSinEncabezado(sin);
      // Por nombre si los encabezados lo dicen; si no, la posición del formato teléfono | nombre | DNI
      setColTel(cols.find((x) => /tel|cel|movil|móvil|numero|número/i.test(x)) ?? cols[0] ?? '');
      setColNombre(cols.find((x) => /nombre|cliente|titular/i.test(x)) ?? cols[1] ?? '');
      setColDni(cols.find((x) => /dni|documento|doc\b|cuil|cuit/i.test(x)) ?? cols[2] ?? '');
    } catch {
      setError('No se pudo leer el archivo');
    }
  };

  const subir = async (e: FormEvent) => {
    e.preventDefault();
    if (!archivo) return;
    const datos = new FormData();
    datos.append('columna_telefono', colTel);
    if (colNombre) datos.append('columna_nombre', colNombre);
    if (colDni) datos.append('columna_dni', colDni);
    if (nombre.trim()) datos.append('nombre', nombre.trim());
    datos.append('archivo', archivo); // el archivo va al final: el backend lee los campos antes
    if (await ejecutar(async () => setResultado(await api.post<ResultadoCarga>(`/api/campanas/${campanaId}/listas`, datos)))) onCargada();
  };

  return (
    <Modal titulo="Cargar base" onCerrar={onCerrar}>
      {resultado ? (
        <div className="pila" style={{ gap: 12 }}>
          <div className="alerta info">Se cargaron <strong>{numero(resultado.cargados)}</strong> contactos de {numero(resultado.filas_archivo)} filas.</div>
          <ul className="lista">
            <li><span>Ya estaban en No Llame</span><strong>{numero(resultado.descartados_no_llame)}</strong></li>
            <li><span>Repetidos en la campaña</span><strong>{numero(resultado.descartados_duplicados)}</strong></li>
            <li><span>Números inválidos</span><strong>{numero(resultado.descartados_invalidos)}</strong></li>
          </ul>
          {resultado.ejemplos_invalidos.length > 0 && <div className="suave chico">Ejemplos inválidos: {resultado.ejemplos_invalidos.join(', ')}</div>}
          <div><button className="primario" onClick={onCerrar}>Listo</button></div>
        </div>
      ) : (
        <form className="pila" onSubmit={subir} style={{ gap: 14 }}>
          <div className="alerta info">Formato: <strong>número | nombre | DNI</strong> y después todas las columnas que quieras (se muestran en la ficha del vendedor). Separado por ; o , con o sin encabezados.</div>
          <Campo etiqueta="Archivo CSV" ayuda="UTF-8 o Excel (Windows).">
            <input type="file" accept=".csv,.txt,text/csv" onChange={(e) => void elegir(e.target.files?.[0] ?? null)} required />
          </Campo>
          {columnas.length > 0 && (
            <div className="rejilla">
              <Campo etiqueta="Columna del teléfono">
                <select value={colTel} onChange={(e) => setColTel(e.target.value)}>{columnas.map((x) => <option key={x}>{x}</option>)}</select>
              </Campo>
              <Campo etiqueta="Columna del nombre">
                <select value={colNombre} onChange={(e) => setColNombre(e.target.value)}>
                  <option value="">Ninguna</option>
                  {columnas.map((x) => <option key={x}>{x}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Columna del DNI">
                <select value={colDni} onChange={(e) => setColDni(e.target.value)}>
                  <option value="">Ninguna</option>
                  {columnas.map((x) => <option key={x}>{x}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Nombre de la base"><input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={200} /></Campo>
            </div>
          )}
          {columnas.length > 0 && <small className="suave chico">{sinEncabezado ? 'El archivo no tiene encabezados: se toma columna 1 = número, 2 = nombre, 3 = DNI. ' : ''}Las demás columnas se muestran en la ficha del vendedor.</small>}
          <MensajeError mensaje={error} />
          <div><button className="primario" disabled={ocupado || !archivo || !colTel}>{ocupado ? 'Cargando…' : 'Cargar'}</button></div>
        </form>
      )}
    </Modal>
  );
}

const RECICLABLES: [string, string][] = [
  ['no_contesta', 'No contesta'], ['ocupado', 'Ocupado'], ['fallida', 'Fallida'], ['contestador', 'Contestador'],
  ['abandonada', 'Abandonada'], ['corto_en_mensaje', 'Cortó en el mensaje'], ['sin_confirmar', 'No marcó la tecla'],
];

function Reciclar({ lista, onCerrar, onHecho }: { lista: Lista; onCerrar: () => void; onHecho: () => void }) {
  const [elegidos, setElegidos] = useState<string[]>(['no_contesta', 'ocupado']);
  const [reiniciar, setReiniciar] = useState(true);
  const [hecho, setHecho] = useState<number | null>(null);
  const { ocupado, error, ejecutar } = useAccion();

  const confirmar = async () => {
    let n = 0;
    const ok = await ejecutar(async () => {
      ({ reciclados: n } = await api.post<{ reciclados: number }>(`/api/listas/${lista.id}/reciclar`, { resultados: elegidos, reiniciar_intentos: reiniciar }));
    });
    if (ok) {
      setHecho(n);
      onHecho();
    }
  };

  return (
    <Modal titulo={`Reciclar "${lista.nombre}"`} onCerrar={onCerrar}>
      {hecho !== null ? (
        <div className="pila" style={{ gap: 12 }}>
          <div className="alerta info">Volvieron a la cola <strong>{numero(hecho)}</strong> contactos.</div>
          <div><button className="primario" onClick={onCerrar}>Listo</button></div>
        </div>
      ) : (
        <div className="pila" style={{ gap: 12 }}>
          <div className="suave">Vuelven a la cola los contactos agotados o para reintentar cuyo último resultado fue:</div>
          {RECICLABLES.map(([r, t]) => (
            <Interruptor key={r} etiqueta={t} valor={elegidos.includes(r)}
              onCambiar={(v) => setElegidos((x) => (v ? [...x, r] : x.filter((y) => y !== r)))} />
          ))}
          <div className="seccion">
            <Interruptor etiqueta="Reiniciar el contador de intentos" valor={reiniciar} onCambiar={setReiniciar} />
          </div>
          <MensajeError mensaje={error} />
          <div><button className="primario" onClick={() => void confirmar()} disabled={ocupado || elegidos.length === 0}>Reciclar</button></div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Vendedores

function Vendedores({ c, onGuardado }: { c: Campana; onGuardado: () => void }) {
  const { puede } = useSesion();
  const { datos: todos, recargar: recargarVendedores } = useDatos<{ id: number; nombre: string; usuario: string; interno_sip: string | null; recibe_ivr: boolean }[]>('/api/usuarios?rol=vendedor');
  const ivr = useAccion();
  // Recibir IVR es una opción de cada vendedor (vale para todas las campañas con mensaje)
  const alternarIvr = async (id: number, si: boolean) => {
    if (await ivr.ejecutar(() => api.patch(`/api/usuarios/${id}`, { recibe_ivr: si }))) void recargarVendedores();
  };
  const [elegidos, setElegidos] = useState<Set<number>>(() => new Set(c.vendedores.map((v) => v.id)));
  const [buscar, setBuscar] = useState('');
  const { ocupado, error, ejecutar } = useAccion();
  const [guardado, setGuardado] = useState(false);
  const editable = puede('vendedores.asignar');

  const alternar = (id: number, si: boolean) => {
    setElegidos((x) => {
      const n = new Set(x);
      if (si) n.add(id);
      else n.delete(id);
      return n;
    });
    setGuardado(false);
  };
  const visibles = (todos ?? []).filter((v) => !buscar || v.nombre.toLowerCase().includes(buscar.toLowerCase()));
  const guardar = async () => {
    if (await ejecutar(() => api.put(`/api/campanas/${c.id}/vendedores`, { usuarios: [...elegidos] }))) {
      setGuardado(true);
      onGuardado();
    }
  };

  return (
    <section className="tarjeta">
      <div className="fila separada">
        <input placeholder="Buscar vendedor" value={buscar} onChange={(e) => setBuscar(e.target.value)} style={{ maxWidth: 280 }} />
        {editable && (
          <div className="fila">
            <button type="button" onClick={() => setElegidos(new Set((todos ?? []).map((v) => v.id)))}>Todos</button>
            <button type="button" onClick={() => setElegidos(new Set())}>Ninguno</button>
          </div>
        )}
      </div>
      {CON_AUDIO.includes(c.tipo) && <div className="alerta info">De los asignados, solo reciben los clientes que pasan del mensaje quienes tienen <strong>Recibe IVR</strong>. El cambio vale para todas las campañas con mensaje y se aplica enseguida.</div>}
      <div className="tabla-envoltura">
        <table className="tabla compacta">
          <thead><tr><th>Asignado</th><th>Vendedor</th><th>Interno</th><th title="Le pueden llegar los clientes que pasan del mensaje pregrabado">Recibe IVR ⓘ</th></tr></thead>
          <tbody>
            {visibles.map((v) => (
              <tr key={v.id}>
                <td><input type="checkbox" className="casilla" checked={elegidos.has(v.id)} onChange={(e) => alternar(v.id, e.target.checked)} disabled={!editable} aria-label={`Asignar a ${v.nombre}`} /></td>
                <td><strong>{v.nombre}</strong> <span className="suave chico">{v.usuario}</span></td>
                <td className="numero">{v.interno_sip ?? '—'}</td>
                <td>
                  <label className="interruptor" style={{ alignItems: 'center' }}>
                    <input type="checkbox" checked={v.recibe_ivr} onChange={(e) => void alternarIvr(v.id, e.target.checked)} disabled={!puede('vendedores.ivr') || ivr.ocupado} />
                    <span className={v.recibe_ivr ? '' : 'suave'}>{v.recibe_ivr ? 'Sí' : 'No'}</span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MensajeError mensaje={ivr.error} />
      {todos?.length === 0 && <div className="vacio">No hay vendedores activos. Se crean en Usuarios.</div>}
      <MensajeError mensaje={error} />
      {editable && (
        <div className="fila">
          <button className="primario" onClick={() => void guardar()} disabled={ocupado}>Guardar ({elegidos.size} asignados)</button>
          {guardado && <span className="chip ok">Guardado</span>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Gateways

function Gateways({ c, onGuardado }: { c: Campana; onGuardado: () => void }) {
  const { puede } = useSesion();
  const { datos: todos } = useDatos<{ id: number; nombre: string; canales: number; canales_reservados_manual: number; activo: boolean }[]>('/api/gateways');
  const [todosLosGateways, setTodosLosGateways] = useState(c.todos_los_gateways);
  const [elegidos, setElegidos] = useState<Set<number>>(() => new Set(c.gateways.map((g) => g.id)));
  const { ocupado, error, ejecutar } = useAccion();
  const [guardado, setGuardado] = useState(false);
  const editable = puede(c.tipo === 'ivr' ? 'ivr.editar' : 'campanas.editar');

  const guardar = async () => {
    const ok = await ejecutar(async () => {
      await api.put(`/api/campanas/${c.id}/gateways`, { gateways: [...elegidos] });
      if (todosLosGateways !== c.todos_los_gateways) await api.patch(`/api/campanas/${c.id}`, { todos_los_gateways: todosLosGateways });
    });
    if (ok) {
      setGuardado(true);
      onGuardado();
    }
  };

  return (
    <section className="tarjeta">
      <Interruptor etiqueta="Usar todos los gateways activos" ayuda="Si se apaga, la campaña marca solo por los elegidos abajo."
        valor={todosLosGateways} onCambiar={(v) => { setTodosLosGateways(v); setGuardado(false); }} deshabilitado={!editable} />
      {!todosLosGateways && (
        <div className="rejilla">
          {(todos ?? []).map((g) => (
            <Interruptor key={g.id} etiqueta={g.nombre} ayuda={`${g.canales} canales · ${g.canales_reservados_manual} reservados para manual`}
              valor={elegidos.has(g.id)} deshabilitado={!editable}
              onCambiar={(si) => {
                setElegidos((x) => { const n = new Set(x); if (si) n.add(g.id); else n.delete(g.id); return n; });
                setGuardado(false);
              }} />
          ))}
        </div>
      )}
      <MensajeError mensaje={error} />
      {editable && (
        <div className="fila">
          <button className="primario" onClick={() => void guardar()} disabled={ocupado}>Guardar</button>
          {guardado && <span className="chip ok">Guardado</span>}
        </div>
      )}
    </section>
  );
}
