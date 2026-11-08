// Lista de campañas con su avance y alta de campañas nuevas.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Campo, Encabezado, Interruptor, MensajeError, Modal, numero, useAccion, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import type { CampanaAsignada } from '../tipos';

export type TipoCampana = CampanaAsignada['tipo'];
export type EstadoCampana = 'activa' | 'pausada' | 'terminada' | 'archivada';

export const TIPOS: [TipoCampana, string, string][] = [
  ['manual', 'Manual', 'El vendedor pide el próximo contacto y decide llamar.'],
  ['progresivo', 'Progresivo', 'Una llamada por vendedor libre. Sin abandono.'],
  ['predictivo', 'Predictivo', 'Marca de más según la contactabilidad, con control de abandono.'],
  ['predictivo_audio', 'Predictivo con audio', 'Predictivo con mensaje pregrabado antes de pasar al vendedor.'],
  ['ivr', 'IVR', 'Mensaje pregrabado: el cliente marca y le llega como aviso a un vendedor (llamada o WhatsApp), o pasa la llamada.'],
];
export const NOMBRE_TIPO = Object.fromEntries(TIPOS.map(([t, n]) => [t, n])) as Record<TipoCampana, string>;

export const ESTADO_CAMPANA: Record<EstadoCampana, [string, string]> = {
  activa: ['Activa', 'ok'],
  pausada: ['Pausada', 'aviso'],
  terminada: ['Terminada', ''],
  archivada: ['Archivada', ''],
};

export interface Avance {
  leads_total: number;
  leads_sin_llamar: number;
  leads_reintentar: number;
  leads_en_curso: number;
  leads_finalizados: number;
  leads_agotados: number;
  leads_no_llamar: number;
}

interface FilaCampana extends Avance {
  id: number;
  nombre: string;
  tipo: TipoCampana;
  estado: EstadoCampana;
  prioridad: number;
  hora_inicio: string;
  hora_fin: string;
  vendedores: number;
}

/** Barra apilada: cerrados / agotados / por llamar. */
export function BarraAvance({ a }: { a: Avance }) {
  const total = a.leads_total || 1;
  const cerrados = a.leads_finalizados + a.leads_no_llamar;
  const tramos: [number, string, string][] = [
    [cerrados, 'var(--ok)', 'Cerrados'],
    [a.leads_agotados, 'var(--texto-suave)', 'Agotados'],
    [a.leads_reintentar + a.leads_en_curso, 'var(--marca-celeste)', 'Para reintentar'],
  ];
  return (
    <div className="barra-progreso" title={tramos.map(([n, , t]) => `${t}: ${numero(n)}`).join(' · ') + ` · Sin llamar: ${numero(a.leads_sin_llamar)}`}>
      {tramos.map(([n, color, t]) => n > 0 && <div key={t} style={{ width: `${(n / total) * 100}%`, background: color }} />)}
    </div>
  );
}

export function Campanas() {
  const { puede } = useSesion();
  const [archivadas, setArchivadas] = useState(false);
  const [nueva, setNueva] = useState(false);
  const { datos, error } = useDatos<FilaCampana[]>(`/api/campanas?incluir_archivadas=${archivadas}`);
  const navegar = useNavigate();

  return (
    <>
      <Encabezado titulo="Campañas">
        {puede('campanas.editar', 'ivr.editar') && <button className="primario" onClick={() => setNueva(true)}>Nueva campaña</button>}
      </Encabezado>
      <div className="fila" style={{ marginBottom: 12 }}>
        <Interruptor etiqueta="Mostrar archivadas" valor={archivadas} onCambiar={setArchivadas} />
      </div>
      <MensajeError mensaje={error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead>
            <tr>
              <th>Campaña</th><th>Tipo</th><th>Estado</th><th>Horario</th><th className="der">Vendedores</th>
              <th className="der">Contactos</th><th className="der">Sin llamar</th><th>Avance</th>
            </tr>
          </thead>
          <tbody>
            {(datos ?? []).map((c) => {
              const [texto, clase] = ESTADO_CAMPANA[c.estado];
              return (
                <tr key={c.id} className="clic" onClick={() => navegar(`/campanas/${c.id}`)}>
                  <td><strong>{c.nombre}</strong></td>
                  <td>{NOMBRE_TIPO[c.tipo]}</td>
                  <td><span className={`chip ${clase}`}>{texto}</span></td>
                  <td className="numero">{c.hora_inicio}–{c.hora_fin}</td>
                  <td className="der numero">{c.vendedores}</td>
                  <td className="der numero">{numero(c.leads_total)}</td>
                  <td className="der numero">{numero(c.leads_sin_llamar)}</td>
                  <td><BarraAvance a={c} /></td>
                </tr>
              );
            })}
            {datos?.length === 0 && <tr><td colSpan={8} className="vacio">Todavía no hay campañas.</td></tr>}
          </tbody>
        </table>
      </div>
      {nueva && <NuevaCampana onCerrar={() => setNueva(false)} onCreada={(id) => navegar(`/campanas/${id}`)} />}
    </>
  );
}

export function NuevaCampana({ onCerrar, onCreada, tipoInicial }: { onCerrar: () => void; onCreada: (id: number) => void; tipoInicial?: TipoCampana }) {
  const { puede } = useSesion();
  const [nombre, setNombre] = useState('');
  const tipos = TIPOS.filter(([t]) => puede(t === 'ivr' ? 'ivr.editar' : 'campanas.editar'));
  const [tipo, setTipo] = useState<TipoCampana>(tipos.find(([t]) => t === (tipoInicial ?? 'predictivo'))?.[0] ?? tipos[0]![0]);
  const { ocupado, error, ejecutar } = useAccion();

  const crear = async (e: FormEvent) => {
    e.preventDefault();
    let id = 0;
    // Un IVR nuevo arranca como aviso al vendedor (1 = llamada, 2 = WhatsApp), que es el uso principal
    const extra = tipo === 'ivr' ? { ivr_destino: 'aviso' } : {};
    if (await ejecutar(async () => ({ id } = await api.post<{ id: number }>('/api/campanas', { nombre, tipo, ...extra })))) onCreada(id);
  };

  return (
    <Modal titulo="Nueva campaña" onCerrar={onCerrar}>
      <form className="pila" onSubmit={crear} style={{ gap: 14 }}>
        <Campo etiqueta="Nombre">
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} required maxLength={120} autoFocus />
        </Campo>
        <div className="pila">
          <span className="suave chico">Tipo</span>
          {tipos.map(([t, n, d]) => (
            <label key={t} className="interruptor">
              <input type="radio" name="tipo" checked={tipo === t} onChange={() => setTipo(t)} />
              <div><div>{n}</div><small className="suave chico">{d}</small></div>
            </label>
          ))}
        </div>
        <div className="suave chico">Se crea pausada. Después configurás el horario, la base, los vendedores y la encendés.</div>
        <MensajeError mensaje={error} />
        <div><button className="primario" disabled={ocupado}>Crear</button></div>
      </form>
    </Modal>
  );
}
