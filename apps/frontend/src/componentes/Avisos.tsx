// Avisos del IVR: el cliente marcó la tecla de llamada o de WhatsApp. Tabla compartida por la
// sección IVR (todos) y Mis avisos (los del vendedor).
import { api } from '../api';
import { fechaHora, useAccion } from './ui';

export interface Aviso {
  id: number;
  llamada_id: number | null;
  campana_id: number | null;
  campana: string | null;
  telefono: string;
  nombre: string | null;
  contacto: 'llamada' | 'whatsapp';
  tecla: string;
  vendedor_id: number | null;
  vendedor: string | null;
  estado: 'pendiente' | 'contactado' | 'descartado';
  visto_en: string | null;
  cerrado_en: string | null;
  notas: string | null;
  creado_en: string;
  // Leads del bot de WhatsApp
  origen: 'ivr' | 'whatsapp';
  dni: string | null;
  dni_texto: string | null;
  compania: string | null;
  interes: 'portabilidad' | 'fibra' | null;
  direccion: string | null;
  chat_hora: string | null;
  actualizado_en: string | null;
}

/** Producto del aviso: el interés del lead, o en los del IVR el comienzo del nombre de la campaña. */
export function productoDe(a: Pick<Aviso, 'interes' | 'campana'>): 'portabilidad' | 'fibra' | null {
  if (a.interes) return a.interes;
  const c = (a.campana ?? '').trim().toUpperCase();
  if (c.startsWith('FIBRA')) return 'fibra';
  if (c.startsWith('PORTA')) return 'portabilidad';
  return null;
}

export function EtiquetaProducto({ aviso }: { aviso: Pick<Aviso, 'interes' | 'campana'> }) {
  const p = productoDe(aviso);
  if (!p) return null;
  return <span className={`chip ${p === 'fibra' ? 'info' : 'ok'}`}><strong>{p === 'fibra' ? 'FIBRA' : 'PORTA'}</strong></span>;
}

export const TEXTO_CONTACTO: Record<Aviso['contacto'], string> = { llamada: '📞 Llamada', whatsapp: '💬 WhatsApp' };
export const ESTADO_AVISO: Record<Aviso['estado'], [string, string]> = {
  pendiente: ['Pendiente', 'aviso'],
  contactado: ['Contactado', 'ok'],
  descartado: ['Descartado', ''],
};

/** 2617256360 -> "261 725-6360" */
export function formatoTelefono(t: string): string {
  if (!/^\d{10}$/.test(t)) return t;
  return t.startsWith('11') ? `11 ${t.slice(2, 6)}-${t.slice(6)}` : `${t.slice(0, 3)} ${t.slice(3, 6)}-${t.slice(6)}`;
}

export const enlaceWhatsapp = (t: string) => `https://web.whatsapp.com/send?phone=549${t}`;

export function TablaAvisos({ avisos, conVendedor, vendedores, onCambio, leads }: {
  avisos: Aviso[];
  conVendedor?: boolean;
  /** Leads del bot: en lugar de la campaña muestra producto, compañía, DNI y dirección */
  leads?: boolean;
  /** Si viene, se puede reasignar cada aviso pendiente */
  vendedores?: { id: number; nombre: string }[];
  onCambio: () => void;
}) {
  const { ocupado, error, ejecutar } = useAccion();
  const estado = async (a: Aviso, e: Aviso['estado']) => {
    if (await ejecutar(() => api.post(`/api/avisos/${a.id}/estado`, { estado: e }))) onCambio();
  };
  const reasignar = async (a: Aviso, vendedorId: number) => {
    if (await ejecutar(() => api.post(`/api/avisos/${a.id}/reasignar`, { vendedor_id: vendedorId }))) onCambio();
  };

  return (
    <>
      {error && <div className="alerta">{error}</div>}
      <div className="tabla-envoltura">
        <table className="tabla compacta">
          <thead>
            <tr>
              <th>Hora</th>{leads ? <th>Producto</th> : <th>Quiere</th>}<th>Número</th><th>Nombre</th>
              {leads ? <><th>Compañía</th><th>DNI</th><th>Dirección</th></> : <th>Campaña</th>}
              {conVendedor && <th>Vendedor</th>}<th>Estado</th><th></th>
            </tr>
          </thead>
          <tbody>
            {avisos.map((a) => {
              const [texto, clase] = ESTADO_AVISO[a.estado];
              return (
                <tr key={a.id}>
                  <td className="numero">{fechaHora(a.creado_en)}</td>
                  {leads
                    ? <td><EtiquetaProducto aviso={a} /></td>
                    : <td><strong>{TEXTO_CONTACTO[a.contacto]}</strong> <EtiquetaProducto aviso={a} /></td>}
                  <td className="numero"><strong>{formatoTelefono(a.telefono)}</strong></td>
                  <td>{a.nombre ?? <span className="suave">—</span>}</td>
                  {leads ? (
                    <>
                      <td>{a.compania ?? <span className="suave">—</span>}</td>
                      <td className="numero">
                        {a.dni ?? <span className="chip aviso" title={a.dni_texto ? `Respondió: "${a.dni_texto}"` : undefined}>Revisar DNI</span>}
                      </td>
                      <td style={{ whiteSpace: 'pre-line', maxWidth: 260 }}>{a.direccion ?? <span className="suave">—</span>}</td>
                    </>
                  ) : <td>{a.campana ?? '—'}</td>}
                  {conVendedor && (
                    <td>
                      {vendedores && a.estado === 'pendiente' ? (
                        <select value={a.vendedor_id ?? ''} disabled={ocupado} onChange={(e) => void reasignar(a, Number(e.target.value))}>
                          {!a.vendedor_id && <option value="">Sin asignar</option>}
                          {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nombre}</option>)}
                        </select>
                      ) : (a.vendedor ?? <span className="suave">Sin asignar</span>)}
                      {a.estado === 'pendiente' && a.vendedor_id && <div className="suave chico">{a.visto_en ? 'Visto' : 'Sin ver'}</div>}
                    </td>
                  )}
                  <td><span className={`chip ${clase}`}>{texto}</span></td>
                  <td>
                    <div className="fila" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      {a.contacto === 'whatsapp' && (
                        <a className="boton" href={enlaceWhatsapp(a.telefono)} target="_blank" rel="noreferrer"><button className="chico">WhatsApp</button></a>
                      )}
                      {a.estado === 'pendiente' ? (
                        <>
                          <button className="chico primario" disabled={ocupado} onClick={() => void estado(a, 'contactado')}>Contactado</button>
                          <button className="chico" disabled={ocupado} onClick={() => void estado(a, 'descartado')}>Descartar</button>
                        </>
                      ) : (
                        <button className="chico" disabled={ocupado} onClick={() => void estado(a, 'pendiente')}>Reabrir</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {avisos.length === 0 && <tr><td colSpan={(conVendedor ? 8 : 7) + (leads ? 2 : 0)} className="vacio">{leads ? 'No hay leads.' : 'No hay avisos.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
