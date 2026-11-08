// Puesto del vendedor (§9): línea, estado y descansos, ficha del cliente, tipificación,
// vista previa de campañas manuales, marcación manual y pendientes.
import { useEffect, useRef, useState } from 'react';
import { api, mensajeDeError } from '../api';
import { BarraTelefono } from '../componentes/BarraTelefono';
import { FichaCliente, Llamando, ListaPendientes, MarcadorManual, PanelTipificacion, VistaPrevia } from '../componentes/PiezasPuesto';
import { useYo } from '../sesion';
import { useTelefono } from '../telefono/contexto';
import { usePuesto } from '../telefono/usePuesto';
import { puedeLlamar } from '../menu';
import type { EstadoPuesto, MotivoDescanso, Tipificacion } from '../tipos';
import { duracion, useAhora } from '../utilidades';

const ESTADO: Record<EstadoPuesto | 'sin_linea', string> = {
  disponible: 'Disponible',
  en_llamada: 'En llamada',
  tipificando: 'Tipificando',
  descanso: 'En descanso',
  sin_linea: 'Sin línea',
};

export function Puesto() {
  const yo = useYo();
  const { softphone, estado: tel } = useTelefono();
  const { puesto, ficha, marcando, inicioLlamada, porTipificar, setPorTipificar, pendientes, acciones } = usePuesto(tel?.volumen ?? 1);
  const [tipificaciones, setTipificaciones] = useState<Tipificacion[]>([]);
  const [motivos, setMotivos] = useState<MotivoDescanso[]>([]);
  const [notas, setNotas] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const ahora = useAhora();

  useEffect(() => {
    void api.get<Tipificacion[]>('/api/tipificaciones').then(setTipificaciones).catch(() => {});
    void api.get<MotivoDescanso[]>('/api/motivos-descanso').then((m) => setMotivos(m.filter((x) => x.visible))).catch(() => {});
  }, []);

  // Volumen inicial del panel, una sola vez
  const volumenAplicado = useRef(false);
  useEffect(() => {
    if (!puesto || !softphone || volumenAplicado.current) return;
    volumenAplicado.current = true;
    softphone.fijarVolumen(puesto.volumen_inicial);
  }, [puesto, softphone]);

  if (!puesto) return <div className="suave">Cargando el puesto…</div>;

  const estadoVisible: EstadoPuesto | 'sin_linea' = puesto.linea_conectada && puesto.estado ? puesto.estado : 'sin_linea';
  const motivo = motivos.find((m) => m.id === puesto.motivo_descanso_id);
  const segundosEstado = puesto.desde ? (ahora - puesto.desde) / 1000 : null;
  const descansoExcedido = estadoVisible === 'descanso' && motivo?.max_minutos && segundosEstado && segundosEstado > motivo.max_minutos * 60;
  const libre = puesto.linea_conectada && !ficha && (puesto.estado === 'disponible' || puesto.estado === 'descanso' || (puesto.estado === 'tipificando' && !puesto.tipificacion_obligatoria));
  const campanasManuales = puesto.campanas.filter((c) => c.tipo === 'manual');

  const hacer = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(mensajeDeError(err));
    }
  };

  // Llamada que se está tipificando: la actual (pre-tipificación) o la que terminó
  const llamadaTipificar = ficha?.llamada_id ?? porTipificar?.llamada_id ?? null;
  // Admin o supervisor: el discador no le pasa llamadas, solo llama a mano
  const esVendedor = yo.rol === 'vendedor';
  const notasDe = (id: number | null) => (id ? notas[id] ?? '' : '');
  const setNotasDe = (id: number) => (n: string) => setNotas((x) => ({ ...x, [id]: n }));

  return (
    <div className="puesto">
      <div className="puesto-barra tarjeta" style={{ display: 'flex' }}>
        <div className={`estado-grande estado-${estadoVisible}`}>
          {ESTADO[estadoVisible]}
          {estadoVisible === 'descanso' && motivo && <span style={{ fontWeight: 500 }}>· {motivo.nombre}</span>}
          {segundosEstado !== null && estadoVisible !== 'sin_linea' && (
            <span className="numero" style={{ fontWeight: 500 }}>{duracion(segundosEstado)}</span>
          )}
        </div>
        {esVendedor && puesto.linea_conectada && puesto.estado !== 'en_llamada' && (
          <div className="fila">
            {puesto.estado !== 'disponible' && (
              <button className="ok" onClick={() => void hacer(acciones.disponible)}
                disabled={puesto.estado === 'tipificando' && puesto.tipificacion_obligatoria}>
                Ponerme disponible
              </button>
            )}
            <select
              value="" style={{ width: 'auto' }}
              onChange={(e) => e.target.value && void hacer(() => acciones.descanso(Number(e.target.value)))}
              disabled={puesto.estado === 'tipificando' && puesto.tipificacion_obligatoria}
            >
              <option value="">{puesto.estado === 'descanso' ? 'Cambiar descanso…' : 'Tomar descanso…'}</option>
              {motivos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nombre}{m.max_minutos ? ` (máx. ${m.max_minutos} min)` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        {esVendedor && (puesto.recibe_ivr ?? yo.recibe_ivr) && (
          <span className="chip info" title="Te pueden llegar clientes que pasaron el mensaje pregrabado">IVR activo</span>
        )}
        <div className="espaciador" />
        <BarraTelefono lineaEnServidor={puesto.linea_conectada} interno={yo.interno_sip} />
      </div>

      <div className="pila" style={{ gap: 16 }}>
        {error && <div className="alerta peligro">{error}</div>}
        {descansoExcedido && <div className="alerta">Te pasaste del tiempo máximo de este descanso.</div>}

        {!ficha && marcando && <Llamando telefono={marcando.telefono} desde={marcando.desde} onColgar={acciones.colgar} />}
        {ficha && <FichaCliente ficha={ficha} inicio={inicioLlamada} onColgar={acciones.colgar} />}

        {llamadaTipificar && (ficha || porTipificar) && (
          <PanelTipificacion
            llamadaId={llamadaTipificar}
            enCurso={!!ficha}
            porTipificar={ficha ? null : porTipificar}
            tipificaciones={tipificaciones}
            notas={notasDe(llamadaTipificar)}
            setNotas={setNotasDe(llamadaTipificar)}
            onGuardar={acciones.tipificar}
            onCerrar={acciones.descartarTipificacion}
          />
        )}

        {!ficha && !marcando && !porTipificar && (
          <section className="tarjeta esperando">
            {!puesto.linea_conectada ? (
              <div>Conectá la línea para empezar a recibir llamadas.</div>
            ) : !esVendedor ? (
              <div>Línea lista. Marcá el número en <strong>Llamada manual</strong>: vas a escuchar el tono mientras suena.</div>
            ) : puesto.estado === 'descanso' ? (
              <div>Estás en descanso: no te van a entrar llamadas.</div>
            ) : (
              <>
                <div className="fila" style={{ justifyContent: 'center', gap: 10 }}>
                  <div className="pulso" style={{ margin: 0 }} />
                  <strong style={{ fontSize: 18, color: 'var(--texto)' }}>Recibiendo llamadas</strong>
                </div>
                {puesto.estado === 'disponible' && segundosEstado !== null && (
                  <div className="sin-llamada">
                    <span>Sin recibir una llamada hace</span>
                    <strong className="numero">{duracion(segundosEstado)}</strong>
                  </div>
                )}
                {puesto.campanas.length > 0 && (
                  <div className="chico" style={{ marginTop: 6 }}>
                    {puesto.campanas.map((c) => c.nombre).join(' · ')}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {!ficha && campanasManuales.length > 0 && (
          <VistaPrevia campanas={campanasManuales} habilitado={!!libre} onLlamar={(t, id) => acciones.llamar(t, id)} />
        )}
      </div>

      <aside className="pila" style={{ gap: 16 }}>
        {puedeLlamar(yo) && <MarcadorManual habilitado={!!libre} onLlamar={(t) => acciones.llamar(t)} />}
        <ListaPendientes
          pendientes={pendientes}
          actual={porTipificar?.llamada_id ?? null}
          onElegir={(p) =>
            !ficha && setPorTipificar({ llamada_id: p.id, ficha: null, obligatoria: false, telefono: p.lead_nombre ? `${p.lead_nombre} · ${p.telefono}` : p.telefono })
          }
        />
      </aside>
    </div>
  );
}
