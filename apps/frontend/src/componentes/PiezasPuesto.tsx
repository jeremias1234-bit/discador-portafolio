// Piezas de la pantalla del puesto: ficha del cliente, tipificación, vista previa,
// marcación manual y llamadas pendientes de tipificar.
import { useEffect, useState, type FormEvent } from 'react';
import { api, mensajeDeError } from '../api';
import type { PorTipificar } from '../telefono/usePuesto';
import type { CampanaAsignada, Ficha, Lead, Pendiente, Tipificacion } from '../tipos';
import { duracion, etiqueta, horaCorta, useAhora } from '../utilidades';

const ORIGEN: Record<Ficha['origen'], string> = { discador: 'Discador', manual: 'Manual', ivr: 'IVR' };

function DatosLead({ lead }: { lead: Lead }) {
  const campos = Object.entries(lead.datos ?? {}).filter(([, v]) => v !== null && v !== '');
  return (
    <>
      {campos.length > 0 && (
        <dl className="datos-lead">
          {campos.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{etiqueta(k)}</dt>
              <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="suave chico">
        {/* intentos cuenta las llamadas ya terminadas: esta es la siguiente */}
        Intento {lead.intentos + 1}
        {lead.ultimo_resultado && ` · último resultado: ${lead.ultimo_resultado.replace(/_/g, ' ')}`}
      </div>
    </>
  );
}

/** Lo primero que ve el vendedor: número, nombre y DNI (formato de las bases). */
function Identidad({ nombre, telefono, dni }: { nombre: string | null; telefono: string; dni: string | null }) {
  return (
    <div className="identidad">
      <div><span>Número</span><strong className="telefono-cliente numero">{telefono}</strong></div>
      <div><span>Nombre</span><strong className="nombre-cliente">{nombre || '—'}</strong></div>
      <div><span>DNI</span><strong className="nombre-cliente numero">{dni || '—'}</strong></div>
    </div>
  );
}

export function FichaCliente({ ficha, inicio, onColgar }: { ficha: Ficha; inicio: number | null; onColgar: () => Promise<unknown> }) {
  const ahora = useAhora();
  const [colgando, setColgando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const colgar = async () => {
    setColgando(true);
    setError(null);
    try {
      await onColgar();
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setColgando(false);
    }
  };

  return (
    <section className="tarjeta">
      <div className="fila separada">
        <div className="fila">
          <span className="chip info">En llamada</span>
          <span className="chip">{ORIGEN[ficha.origen]}</span>
          {ficha.campana && <span className="suave">{ficha.campana.nombre}</span>}
          {ficha.tecla_ivr && <span className="chip ok">Marcó {ficha.tecla_ivr} en el mensaje</span>}
        </div>
        <span className="numero" style={{ fontSize: 18, fontWeight: 600 }}>
          {inicio ? duracion((ahora - inicio) / 1000) : ''}
        </span>
      </div>
      {(ficha.origen === 'ivr' || ficha.tecla_ivr || ficha.campana?.tipo === 'predictivo_audio') && (
        <div className="alerta info ivr-banner">
          <strong>Cliente del IVR:</strong> escuchó el mensaje pregrabado y {ficha.tecla_ivr ? `marcó ${ficha.tecla_ivr} para hablar con un asesor` : 'se quedó en línea esperando un asesor'}.
        </div>
      )}
      <Identidad nombre={ficha.lead?.nombre ?? null} telefono={ficha.telefono} dni={ficha.lead?.dni ?? null} />
      {ficha.lead && <DatosLead lead={ficha.lead} />}
      {error && <div className="alerta peligro">{error}</div>}
      <div>
        <button className="peligro grande" onClick={() => void colgar()} disabled={colgando}>
          Colgar
        </button>
      </div>
    </section>
  );
}

/** Llamada manual sonando: se escucha el tono hasta que atienden o se corta. */
export function Llamando({ telefono, desde, onColgar }: { telefono: string; desde: number; onColgar: () => Promise<unknown> }) {
  const ahora = useAhora();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="tarjeta llamando">
      <div className="fila separada">
        <span className="chip aviso">Llamando…</span>
        <span className="numero suave">sonando hace {duracion((ahora - desde) / 1000)}</span>
      </div>
      <div className="telefono-cliente numero">{telefono}</div>
      {error && <div className="alerta peligro">{error}</div>}
      <div>
        <button className="peligro grande" onClick={() => void onColgar().catch((err: unknown) => setError(mensajeDeError(err)))}>Cortar</button>
      </div>
    </section>
  );
}

/**
 * Tipificación. Durante la llamada se puede elegir y escribir notas; se guarda al cortar.
 */
export function PanelTipificacion({
  llamadaId, enCurso, porTipificar, tipificaciones, notas, setNotas, onGuardar, onCerrar,
}: {
  llamadaId: number;
  enCurso: boolean;
  porTipificar: PorTipificar | null;
  tipificaciones: Tipificacion[];
  notas: string;
  setNotas: (n: string) => void;
  onGuardar: (d: { llamada_id: number; tipificacion_id: number; notas?: string; reintentar_en_min?: number }) => Promise<void>;
  onCerrar?: () => void;
}) {
  const [elegida, setElegida] = useState<number | null>(null);
  const [minutos, setMinutos] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = tipificaciones.find((x) => x.id === elegida);

  useEffect(() => {
    setElegida(null);
    setMinutos('');
    setError(null);
  }, [llamadaId]);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!elegida) return;
    setGuardando(true);
    setError(null);
    try {
      const min = Number(minutos);
      await onGuardar({
        llamada_id: llamadaId,
        tipificacion_id: elegida,
        notas: notas.trim() || undefined,
        reintentar_en_min: t && !t.es_final && minutos && min > 0 ? min : undefined,
      });
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setGuardando(false);
    }
  };

  const sinFicha = porTipificar && !porTipificar.ficha;
  return (
    <form className="tarjeta" onSubmit={guardar}>
      <div className="fila separada">
        <h2>
          {enCurso ? 'Resultado de la llamada' : 'Tipificá la llamada'}
          {sinFicha && <span className="suave"> · {porTipificar.telefono ?? `llamada #${llamadaId}`}</span>}
        </h2>
        {!enCurso && porTipificar && !porTipificar.obligatoria && onCerrar && (
          <button type="button" onClick={onCerrar}>
            Después
          </button>
        )}
      </div>
      {!enCurso && porTipificar?.obligatoria && (
        <div className="alerta">No vas a recibir otra llamada hasta tipificar esta.</div>
      )}
      <div className="tipificaciones">
        {tipificaciones.map((x) => (
          <button
            type="button" key={x.id} onClick={() => setElegida(x.id)}
            className={[x.id === elegida && 'seleccionado', x.es_venta && 'venta', x.marca_no_llame && 'no-llame', x.es_contestador && 'contestador'].filter(Boolean).join(' ')}
          >
            {x.nombre}
            {x.es_venta && <div className="chico" style={{ color: 'var(--ok)' }}>Venta</div>}
            {x.marca_no_llame && <div className="chico" style={{ color: 'var(--peligro)' }}>Pasa a No Llame</div>}
            {x.es_contestador ? <div className="chico suave">Atendió una máquina</div> : !x.es_final && <div className="chico suave">Se vuelve a llamar</div>}
          </button>
        ))}
      </div>
      {t && !t.es_final && (
        <label style={{ maxWidth: 260 }}>
          <span>Volver a llamar en (minutos)</span>
          <input
            type="number" min={1} max={43200} value={minutos} onChange={(e) => setMinutos(e.target.value)}
            placeholder={t.reintentar_en_min ? String(t.reintentar_en_min) : 'lo que diga la campaña'}
          />
        </label>
      )}
      <label>
        <span>Notas</span>
        <textarea value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={2000} />
      </label>
      {error && <div className="alerta peligro">{error}</div>}
      <div className="fila">
        <button className="primario grande" disabled={!elegida || enCurso || guardando}>
          {enCurso ? 'Se guarda al cortar' : guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </form>
  );
}

/** Campañas manuales: el vendedor pide el próximo contacto, lo mira y decide llamar o saltar. */
export function VistaPrevia({
  campanas, habilitado, onLlamar,
}: {
  campanas: CampanaAsignada[];
  habilitado: boolean;
  onLlamar: (telefono: string, leadId: number) => Promise<unknown>;
}) {
  const [campanaId, setCampanaId] = useState<number | null>(campanas[0]?.id ?? null);
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    if (!campanas.some((c) => c.id === campanaId)) setCampanaId(campanas[0]?.id ?? null);
  }, [campanas, campanaId]);

  const hacer = async (fn: () => Promise<void>) => {
    setOcupado(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setOcupado(false);
    }
  };

  const siguiente = () => hacer(async () => setLead(await api.post<Lead>('/api/puesto/siguiente', { campana_id: campanaId })));
  const saltar = () =>
    hacer(async () => {
      if (lead) await api.post('/api/puesto/saltar', { lead_id: lead.id });
      setLead(null);
    });
  const llamar = () =>
    hacer(async () => {
      if (!lead) return;
      await onLlamar(lead.telefono, lead.id);
      setLead(null);
    });

  if (campanas.length === 0) return null;
  return (
    <section className="tarjeta">
      <h3>Campaña manual</h3>
      {!lead ? (
        <div className="fila">
          {campanas.length > 1 && (
            <select value={campanaId ?? ''} onChange={(e) => setCampanaId(Number(e.target.value))} style={{ width: 'auto' }}>
              {campanas.map((c) => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
              ))}
            </select>
          )}
          <button className="primario" onClick={() => void siguiente()} disabled={!habilitado || ocupado || !campanaId}>
            Próximo contacto{campanas.length === 1 ? ` de ${campanas[0]!.nombre}` : ''}
          </button>
        </div>
      ) : (
        <>
          <Identidad nombre={lead.nombre} telefono={lead.telefono} dni={lead.dni} />
          <DatosLead lead={lead} />
          <div className="fila">
            <button className="ok grande" onClick={() => void llamar()} disabled={!habilitado || ocupado}>
              Llamar
            </button>
            <button onClick={() => void saltar()} disabled={ocupado}>
              Saltar
            </button>
          </div>
        </>
      )}
      {error && <div className="alerta peligro">{error}</div>}
    </section>
  );
}

const TECLAS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

export function MarcadorManual({ habilitado, onLlamar }: { habilitado: boolean; onLlamar: (telefono: string) => Promise<unknown> }) {
  const [numero, setNumero] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [llamando, setLlamando] = useState(false);

  const llamar = async (e: FormEvent) => {
    e.preventDefault();
    setLlamando(true);
    setError(null);
    try {
      await onLlamar(numero);
      setNumero('');
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setLlamando(false);
    }
  };

  const tecla = (t: string) => {
    if (t === '⌫') setNumero((n) => n.slice(0, -1));
    else if (t) setNumero((n) => n + t);
  };

  return (
    <form className="tarjeta" onSubmit={llamar}>
      <h3>Llamada manual</h3>
      <input
        value={numero} onChange={(e) => setNumero(e.target.value.replace(/[^\d+\s()-]/g, ''))}
        placeholder="Código de área y número" inputMode="tel" className="numero" style={{ fontSize: 18 }}
      />
      <div className="teclado">
        {TECLAS.map((t, i) => (
          <button type="button" key={i} onClick={() => tecla(t)} disabled={!t} style={t ? undefined : { visibility: 'hidden' }}>
            {t}
          </button>
        ))}
      </div>
      {error && <div className="alerta peligro">{error}</div>}
      <button className="ok" disabled={!habilitado || llamando || numero.replace(/\D/g, '').length < 6}>
        {llamando ? 'Llamando…' : 'Llamar'}
      </button>
    </form>
  );
}

export function ListaPendientes({
  pendientes, actual, onElegir,
}: {
  pendientes: Pendiente[];
  actual: number | null;
  onElegir: (p: Pendiente) => void;
}) {
  return (
    <section className="tarjeta">
      <h3>Sin tipificar ({pendientes.length})</h3>
      {pendientes.length === 0 ? (
        <div className="vacio">No tenés llamadas pendientes.</div>
      ) : (
        <ul className="lista">
          {pendientes.map((p) => (
            <li key={p.id} className={p.id === actual ? 'activo' : ''}>
              <div>
                <div className="numero">{p.lead_nombre ? `${p.lead_nombre} · ` : ''}{p.telefono}</div>
                <div className="suave chico">
                  {horaCorta(p.inicio)} · {duracion(p.duracion_seg ?? 0)}{p.campana ? ` · ${p.campana}` : ''}
                </div>
              </div>
              <button onClick={() => onElegir(p)} disabled={p.id === actual}>Tipificar</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
