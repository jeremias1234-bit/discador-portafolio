// Configuración (§16): parámetros globales, horario, feriados y bloqueos, tipificaciones, descansos y sedes.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Catalogo, type DefCampo } from '../componentes/Catalogo';
import { Rendimiento } from '../componentes/Rendimiento';
import { Campo, Encabezado, Interruptor, MensajeError, Pestanas, useAccion, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';

type Pestana = 'parametros' | 'horario' | 'bloqueos' | 'tipificaciones' | 'descansos' | 'sedes';

export function Configuracion() {
  const { puede } = useSesion();
  const opciones: [Pestana, string][] = [['parametros', 'Parámetros'], ['horario', 'Horario'], ['bloqueos', 'Feriados y bloqueos'],
    ['tipificaciones', 'Tipificaciones'], ['descansos', 'Descansos'], ['sedes', 'Sedes']];
  const [pestana, setPestana] = useState<Pestana>('parametros');
  return (
    <>
      <Encabezado titulo="Configuración" />
      <Pestanas opciones={opciones} actual={pestana} onCambiar={setPestana} />
      {pestana === 'parametros' && (
        <div className="pila" style={{ gap: 16 }}>
          <Rendimiento editable={puede('config.ritmo')} />
          <Parametros />
        </div>
      )}
      {pestana === 'horario' && <HorarioGlobal editable={puede('config.horario')} />}
      {pestana === 'bloqueos' && <Bloqueos editable={puede('config.horario')} />}
      {pestana === 'tipificaciones' && (
        <Catalogo<Tipificacion> ruta="/api/tipificaciones" campos={CAMPOS_TIPIFICACION} singular="tipificación" columnaActivo="activa" editable={puede('config.tipificacion')}
          nota={<div className="alerta info">Son los botones que ve el vendedor al terminar cada llamada.</div>} />
      )}
      {pestana === 'descansos' && (
        <Catalogo<Descanso> ruta="/api/motivos-descanso" campos={CAMPOS_DESCANSO} singular="motivo" columnaActivo="activo" editable={puede('config.descansos')} />
      )}
      {pestana === 'sedes' && (
        <Catalogo<{ id: number; nombre: string; activa: boolean }> ruta="/api/sedes" singular="sede" columnaActivo="activa" editable={puede('config.sedes')}
          campos={[{ clave: 'nombre', etiqueta: 'Nombre', tipo: 'texto', requerido: true }, { clave: 'activa', etiqueta: 'Activa', tipo: 'si_no', porDefecto: true }]} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Parámetros

interface Parametro { clave: string; valor: unknown; editable: boolean; actualizado_en: string }
interface DefParametro { etiqueta: string; ayuda?: string; unidad?: string; min?: number; max?: number; paso?: number }

const GRUPOS: [string, string][] = [
  ['ritmo', 'Ritmo de marcación'], ['llamadas', 'Llamadas'], ['amd', 'Detección de contestador (AMD)'], ['ivr', 'IVR'], ['tipificacion', 'Tipificación'],
  ['telefono', 'Teléfono del vendedor'], ['grabaciones', 'Grabaciones'], ['no_llame', 'No Llame'], ['general', 'General'],
];

const PARAMETROS: Record<string, DefParametro> = {
  'general.zona_horaria': { etiqueta: 'Zona horaria', ayuda: 'Ej.: America/Argentina/Buenos_Aires.' },
  'general.vendedor_solo_su_campana': { etiqueta: 'El vendedor solo recibe llamadas de sus campañas' },
  'ritmo.llamadas_por_vendedor': { etiqueta: 'Llamadas por vendedor libre (predictivo)', ayuda: 'Valor de partida; cada campaña lo puede cambiar.', min: 0.1, max: 20, paso: 0.1 },
  'ritmo.abandono_objetivo_pct': { etiqueta: 'Abandono objetivo', unidad: '%', ayuda: 'El predictivo baja el ritmo si se pasa.', min: 0, max: 100, paso: 0.5 },
  'ritmo.adaptativo': { etiqueta: 'Ritmo adaptativo', ayuda: 'Ajusta solo según la contactabilidad y el abandono.' },
  'ritmo.muestras_minimas': { etiqueta: 'Intentos antes de adaptar', ayuda: 'Hasta juntar estas llamadas usa el valor fijo.', min: 1 },
  'ritmo.rafaga_por_ciclo': { etiqueta: 'Máximo de llamadas por ciclo', min: 1, max: 200 },
  'ritmo.limite_por_minuto': { etiqueta: 'Máximo de llamadas por minuto (todo el sistema)', min: 1 },
  'ritmo.recuento_campanas_seg': { etiqueta: 'Cada cuánto evalúa el motor', unidad: 's', min: 1, max: 60 },
  'ritmo.aviso_llamada_larga_min': { etiqueta: 'Aviso de llamada larga', unidad: 'min', min: 1 },
  'ritmo.aviso_base_por_acabarse': { etiqueta: 'Aviso de base por acabarse', unidad: 'contactos', min: 0 },
  'ritmo.espera_objetivo_min_seg': { etiqueta: 'Espera entre llamadas: mínimo ideal', unidad: 's', ayuda: 'Guía del monitor para el predictivo.', min: 0 },
  'ritmo.espera_objetivo_max_seg': { etiqueta: 'Espera entre llamadas: máximo ideal', unidad: 's', ayuda: 'Pasado este tiempo sin llamada, el monitor lo marca.', min: 1 },
  'amd.silencio_inicial_ms': { etiqueta: 'Silencio inicial máximo', unidad: 'ms', ayuda: 'Si nadie habla en este tiempo, es contestador.' },
  'amd.saludo_max_ms': { etiqueta: 'Saludo máximo', unidad: 'ms', ayuda: 'Un saludo más largo que esto suele ser contestador.' },
  'amd.silencio_tras_saludo_ms': { etiqueta: 'Silencio después del saludo', unidad: 'ms', ayuda: 'Una persona hace una pausa esperando respuesta.' },
  'amd.tiempo_total_ms': { etiqueta: 'Tiempo total de análisis', unidad: 'ms', ayuda: 'Cuanto más largo, más espera el cliente antes de escuchar a alguien.' },
  'amd.palabra_min_ms': { etiqueta: 'Duración mínima de una palabra', unidad: 'ms' },
  'amd.silencio_entre_palabras_ms': { etiqueta: 'Silencio entre palabras', unidad: 'ms' },
  'amd.palabras_maquina': { etiqueta: 'Palabras para decidir "contestador"' },
  'amd.umbral_silencio': { etiqueta: 'Umbral de silencio', ayuda: 'Nivel de ruido que se considera silencio (por defecto 256).' },
  'amd.palabra_max_ms': { etiqueta: 'Duración máxima de una palabra', unidad: 'ms' },
  'amd.pasar_dudosas': { etiqueta: 'Pasar al vendedor las dudosas', ayuda: 'Si el AMD no está seguro, la llamada pasa igual.' },
  'amd.grabar_deteccion': { etiqueta: 'Grabar la detección', ayuda: 'Guarda los segundos que analiza el AMD para revisarlos en Revisión AMD.' },
  'llamadas.duracion_max_min': { etiqueta: 'Duración máxima de una llamada', unidad: 'min', ayuda: 'El vigilante de canales corta lo que la supere.', min: 1, max: 600 },
  'ivr.prioridad_en_cola': { etiqueta: 'Prioridad a los clientes del IVR', ayuda: 'Quien pasó el mensaje se atiende antes que el resto.' },
  'tipificacion.obligatoria': { etiqueta: 'Tipificación obligatoria', ayuda: 'El vendedor no recibe otra llamada hasta tipificar.' },
  'tipificacion.pendientes_horas': { etiqueta: 'Pendientes de tipificar visibles', unidad: 'h' },
  'tipificacion.duracion_minima_seg': { etiqueta: 'Duración mínima para pedir tipificación', unidad: 's' },
  'telefono.tono_entrada': { etiqueta: 'Pitido al entrar una llamada' },
  'telefono.volumen_inicial': { etiqueta: 'Volumen inicial', ayuda: 'De 0 a 1.', min: 0, max: 1, paso: 0.05 },
  'grabaciones.retencion_dias': { etiqueta: 'Días que se guardan las grabaciones', unidad: 'días', min: 1 },
  'grabaciones.piso_disco_libre_gb': { etiqueta: 'Espacio libre mínimo en disco', unidad: 'GB', ayuda: 'Por debajo, se borran las más viejas.', min: 1 },
  'grabaciones.por_pagina': { etiqueta: 'Grabaciones por página', min: 10, max: 500 },
  'no_llame.alerta_dias_padron': { etiqueta: 'Avisar si el padrón tiene más de', unidad: 'días', min: 1 },
};

function Parametros() {
  const { datos, error, recargar } = useDatos<Parametro[]>('/api/configuracion');
  const [valores, setValores] = useState<Record<string, unknown>>({});
  const { ocupado, error: errorGuardar, ejecutar } = useAccion();
  const [guardado, setGuardado] = useState(false);
  const originales = useMemo(() => Object.fromEntries((datos ?? []).map((p) => [p.clave, p.valor])), [datos]);

  useEffect(() => setValores(originales), [originales]);
  const cambios = Object.fromEntries(Object.entries(valores).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(originales[k])));
  const hayCambios = Object.keys(cambios).length > 0;

  if (!datos) return <MensajeError mensaje={error} />;
  const guardar = async () => {
    if (await ejecutar(() => api.patch('/api/configuracion', cambios))) {
      setGuardado(true);
      void recargar();
    }
  };

  return (
    <div className="pila" style={{ gap: 16 }}>
      {GRUPOS.map(([prefijo, titulo]) => {
        // En el orden de PARAMETROS (agrupados con lógica), no alfabético
        const orden = Object.keys(PARAMETROS);
        const params = datos.filter((p) => p.clave.startsWith(`${prefijo}.`)).sort((a, b) => orden.indexOf(a.clave) - orden.indexOf(b.clave));
        if (params.length === 0) return null;
        const booleanos = params.filter((p) => typeof p.valor === 'boolean');
        const otros = params.filter((p) => typeof p.valor !== 'boolean');
        return (
          <section key={prefijo} className="tarjeta">
            <h2>{titulo}</h2>
            {prefijo === 'amd' && <div className="alerta info">Parámetros de la aplicación AMD de Asterisk. Cambiarlos afecta cuántos contestadores llegan al vendedor y cuántas personas se cortan por error: probar de a poco.</div>}
            {otros.length > 0 && (
              <div className="rejilla">
                {otros.map((p) => {
                  const d = PARAMETROS[p.clave] ?? { etiqueta: p.clave };
                  const v = valores[p.clave];
                  return (
                    <Campo key={p.clave} etiqueta={d.unidad ? `${d.etiqueta} (${d.unidad})` : d.etiqueta} ayuda={d.ayuda}>
                      {typeof p.valor === 'number' ? (
                        <input type="number" value={v === undefined ? '' : String(v)} min={d.min} max={d.max} step={d.paso ?? 1} disabled={!p.editable}
                          onChange={(e) => { setValores((x) => ({ ...x, [p.clave]: e.target.value === '' ? '' : Number(e.target.value) })); setGuardado(false); }} />
                      ) : (
                        <input value={String(v ?? '')} disabled={!p.editable}
                          onChange={(e) => { setValores((x) => ({ ...x, [p.clave]: e.target.value })); setGuardado(false); }} />
                      )}
                    </Campo>
                  );
                })}
              </div>
            )}
            {booleanos.map((p) => {
              const d = PARAMETROS[p.clave] ?? { etiqueta: p.clave };
              return (
                <Interruptor key={p.clave} etiqueta={d.etiqueta} ayuda={d.ayuda} valor={!!valores[p.clave]} deshabilitado={!p.editable}
                  onCambiar={(v) => { setValores((x) => ({ ...x, [p.clave]: v })); setGuardado(false); }} />
              );
            })}
          </section>
        );
      })}
      <div className="barra-guardar">
        <MensajeError mensaje={errorGuardar} />
        <div className="fila">
          <button className="primario" onClick={() => void guardar()} disabled={ocupado || !hayCambios}>
            {hayCambios ? `Guardar ${Object.keys(cambios).length} cambio(s)` : 'Sin cambios'}
          </button>
          {hayCambios && <button onClick={() => setValores(originales)}>Descartar</button>}
          {guardado && !hayCambios && <span className="chip ok">Guardado: se aplica enseguida</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Horario global

interface Franja { dia_semana: number; hora_inicio: string; hora_fin: string }
const DIAS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function HorarioGlobal({ editable }: { editable: boolean }) {
  const { datos, error } = useDatos<Franja[]>('/api/horario');
  const [franjas, setFranjas] = useState<Franja[]>([]);
  const { ocupado, error: errorGuardar, ejecutar } = useAccion();
  const [guardado, setGuardado] = useState(false);

  useEffect(() => { if (datos) setFranjas(datos); }, [datos]);
  const cambiar = (i: number, parcial: Partial<Franja>) => {
    setFranjas((x) => x.map((f, j) => (j === i ? { ...f, ...parcial } : f)));
    setGuardado(false);
  };
  const guardar = async () => {
    const orden = [...franjas].sort((a, b) => a.dia_semana - b.dia_semana || a.hora_inicio.localeCompare(b.hora_inicio));
    if (await ejecutar(() => api.put('/api/horario', { franjas: orden }))) setGuardado(true);
  };

  return (
    <section className="tarjeta">
      <div className="alerta info">Fuera de estas franjas no sale ninguna llamada, ni del discador ni manual. Un día sin franjas = ese día no se marca. Cada campaña puede acotarlo más.</div>
      <MensajeError mensaje={error} />
      {[1, 2, 3, 4, 5, 6, 7].map((d) => {
        const delDia = franjas.map((f, i) => [f, i] as const).filter(([f]) => f.dia_semana === d);
        return (
          <div key={d} className="fila" style={{ borderBottom: '1px solid var(--borde)', paddingBottom: 8 }}>
            <strong style={{ width: 100 }}>{DIAS[d]}</strong>
            {delDia.length === 0 && <span className="suave">No se marca</span>}
            {delDia.map(([f, i]) => (
              <div key={i} className="fila" style={{ gap: 4 }}>
                <input type="time" value={f.hora_inicio} onChange={(e) => cambiar(i, { hora_inicio: e.target.value })} disabled={!editable} style={{ width: 'auto' }} />
                <span>a</span>
                <input type="time" value={f.hora_fin} onChange={(e) => cambiar(i, { hora_fin: e.target.value })} disabled={!editable} style={{ width: 'auto' }} />
                {editable && <button onClick={() => { setFranjas((x) => x.filter((_, j) => j !== i)); setGuardado(false); }} aria-label="Quitar franja">✕</button>}
              </div>
            ))}
            {editable && <button onClick={() => { setFranjas((x) => [...x, { dia_semana: d, hora_inicio: '10:00', hora_fin: '21:00' }]); setGuardado(false); }}>+ Franja</button>}
          </div>
        );
      })}
      <MensajeError mensaje={errorGuardar} />
      {editable && (
        <div className="fila">
          <button className="primario" onClick={() => void guardar()} disabled={ocupado}>Guardar horario</button>
          {guardado && <span className="chip ok">Guardado</span>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Feriados y bloqueos

interface Bloqueo {
  id: number; tipo: 'semanal' | 'fecha'; dia_semana: number | null; fecha: string | null;
  hora_inicio: string | null; hora_fin: string | null; campana_id: number | null; motivo: string; activo: boolean;
}

function Bloqueos({ editable }: { editable: boolean }) {
  const { datos: campanas } = useDatos<{ id: number; nombre: string }[]>('/api/campanas');
  const opcionesCampana: [number, string][] = (campanas ?? []).map((c) => [c.id, c.nombre]);
  const campos: DefCampo<Bloqueo>[] = [
    { clave: 'motivo', etiqueta: 'Motivo', tipo: 'texto', requerido: true, ayuda: 'Ej.: Feriado 20 de noviembre.' },
    { clave: 'tipo', etiqueta: 'Tipo', tipo: 'opciones', requerido: true, porDefecto: 'fecha', opciones: [['fecha', 'Una fecha'], ['semanal', 'Todas las semanas']] },
    { clave: 'fecha', etiqueta: 'Fecha', tipo: 'fecha', nulo: true, visible: (f) => f.tipo === 'fecha' },
    { clave: 'dia_semana', etiqueta: 'Día', tipo: 'opciones', nulo: true, visible: (f) => f.tipo === 'semanal',
      opciones: [1, 2, 3, 4, 5, 6, 7].map((d) => [d, DIAS[d]!] as [number, string]), mostrar: (b) => (b.dia_semana ? DIAS[b.dia_semana] : '—') },
    { clave: 'hora_inicio', etiqueta: 'Desde', tipo: 'hora', nulo: true, ayuda: 'Vacío = todo el día.' },
    { clave: 'hora_fin', etiqueta: 'Hasta', tipo: 'hora', nulo: true },
    { clave: 'campana_id', etiqueta: 'Campaña', tipo: 'opciones', nulo: true, opciones: opcionesCampana, ayuda: 'Vacío = todas las campañas.',
      mostrar: (b) => (b.campana_id ? opcionesCampana.find(([id]) => id === b.campana_id)?.[1] ?? `#${b.campana_id}` : 'Todas') },
    { clave: 'activo', etiqueta: 'Activo', tipo: 'si_no', porDefecto: true },
  ];
  return (
    <Catalogo<Bloqueo> ruta="/api/bloqueos" campos={campos} singular="bloqueo" columnaActivo="activo" editable={editable}
      nota={<div className="alerta info">Momentos en que no se marca aunque esté dentro del horario: feriados, capacitaciones, cortes.</div>} />
  );
}

// ---------------------------------------------------------------- Tipificaciones y descansos

interface Tipificacion {
  id: number; nombre: string; es_final: boolean; es_venta: boolean; es_contestador: boolean; reintentar_en_min: number | null;
  marca_no_llame: boolean; orden: number; activa: boolean;
}

const CAMPOS_TIPIFICACION: DefCampo<Tipificacion>[] = [
  { clave: 'nombre', etiqueta: 'Nombre', tipo: 'texto', requerido: true },
  { clave: 'orden', etiqueta: 'Orden', tipo: 'numero', min: 0, max: 1000, porDefecto: 0 },
  { clave: 'es_final', etiqueta: 'Cierra el contacto', tipo: 'si_no', porDefecto: true, ayuda: 'Si no, el contacto vuelve a la cola para llamarlo otra vez.' },
  { clave: 'reintentar_en_min', etiqueta: 'Volver a llamar en (min)', tipo: 'numero', nulo: true, min: 1, max: 43200, visible: (f) => !f.es_final, ayuda: 'Vacío = lo que diga la campaña.' },
  { clave: 'es_venta', etiqueta: 'Es una venta', tipo: 'si_no', visible: (f) => !!f.es_final, siOculto: false, ayuda: 'Cuenta como venta en los reportes.' },
  { clave: 'marca_no_llame', etiqueta: 'Pasa el número a No Llame', tipo: 'si_no' },
  { clave: 'es_contestador', etiqueta: 'Es un contestador', tipo: 'si_no', visible: (f) => !f.es_venta, siOculto: false, ayuda: 'Marca que el AMD dejó pasar una máquina (aparece en Revisión AMD).' },
  { clave: 'activa', etiqueta: 'Activa', tipo: 'si_no', porDefecto: true },
];

interface Descanso { id: number; nombre: string; max_minutos: number | null; orden: number; visible: boolean; activo: boolean }

const CAMPOS_DESCANSO: DefCampo<Descanso>[] = [
  { clave: 'nombre', etiqueta: 'Nombre', tipo: 'texto', requerido: true },
  { clave: 'max_minutos', etiqueta: 'Máximo (min)', tipo: 'numero', nulo: true, min: 1, max: 600, ayuda: 'Se avisa si se pasa. Vacío = sin máximo.' },
  { clave: 'orden', etiqueta: 'Orden', tipo: 'numero', min: 0, max: 1000, porDefecto: 0 },
  { clave: 'visible', etiqueta: 'Lo elige el vendedor', tipo: 'si_no', porDefecto: true },
  { clave: 'activo', etiqueta: 'Activo', tipo: 'si_no', porDefecto: true },
];
