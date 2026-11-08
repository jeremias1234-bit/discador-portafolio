// Bitácora: quién hizo qué y cuándo (cambios de configuración, usuarios, campañas, descargas...).
import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { Encabezado, fechaHora, MensajeError, useAccion, useDatos } from '../componentes/ui';

interface Registro {
  id: number; ts: string; usuario_id: number | null; usuario_nombre: string | null; accion: string;
  entidad: string | null; entidad_id: string | null; detalle: unknown; ip: string | null;
}

const AREAS: [string, string][] = [
  ['', 'Todo'], ['sesion', 'Sesiones'], ['usuario', 'Usuarios'], ['campana', 'Campañas'], ['lista', 'Bases'], ['no_llame', 'No Llame'],
  ['configuracion', 'Configuración'], ['horario', 'Horario'], ['gateway', 'Gateways'], ['audio', 'Audios'], ['grabacion', 'Grabaciones'], ['supervision', 'Supervisión'],
];
const POR_PAGINA = 100;

export function Bitacora() {
  const { datos: usuarios } = useDatos<{ id: number; nombre: string }[]>('/api/usuarios?incluir_bajas=true');
  const [usuario, setUsuario] = useState('');
  const [area, setArea] = useState('');
  const [registros, setRegistros] = useState<Registro[]>([]);
  const [hayMas, setHayMas] = useState(false);
  const [abierto, setAbierto] = useState<number | null>(null);
  const { ocupado, error, ejecutar } = useAccion();

  const pedir = async (antesDe?: number) => {
    const q = new URLSearchParams({ limite: String(POR_PAGINA) });
    if (usuario) q.set('usuario_id', usuario);
    if (area) q.set('accion', area);
    if (antesDe) q.set('antes_de_id', String(antesDe));
    await ejecutar(async () => {
      const nuevos = await api.get<Registro[]>(`/api/bitacora?${q}`);
      setRegistros((x) => (antesDe ? [...x, ...nuevos] : nuevos));
      setHayMas(nuevos.length === POR_PAGINA);
    });
  };

  // Al cambiar un filtro se empieza de nuevo desde lo más reciente
  useEffect(() => { void pedir(); }, [usuario, area]);

  return (
    <>
      <Encabezado titulo="Bitácora" />
      <div className="fila" style={{ marginBottom: 12 }}>
        <select value={usuario} onChange={(e) => setUsuario(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Todos los usuarios</option>
          {(usuarios ?? []).map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
        </select>
        <select value={area} onChange={(e) => setArea(e.target.value)} style={{ width: 'auto' }}>
          {AREAS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
      </div>
      <MensajeError mensaje={error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead><tr><th>Cuándo</th><th>Usuario</th><th>Acción</th><th>Sobre</th><th>IP</th></tr></thead>
          <tbody>
            {registros.map((r) => (
              <Fragment key={r.id}>
                <tr className={r.detalle ? 'clic' : ''} onClick={() => r.detalle && setAbierto(abierto === r.id ? null : r.id)}>
                  <td className="suave" style={{ whiteSpace: 'nowrap' }}>{fechaHora(r.ts)}</td>
                  <td>{r.usuario_nombre ?? 'Sistema'}</td>
                  <td><code>{r.accion}</code>{r.detalle ? <span className="suave chico"> {abierto === r.id ? '▾' : '▸'}</span> : null}</td>
                  <td>{r.entidad ? `${r.entidad} ${r.entidad_id ?? ''}` : '—'}</td>
                  <td className="suave">{r.ip ?? '—'}</td>
                </tr>
                {abierto === r.id && (
                  <tr>
                    <td colSpan={5}><pre className="detalle-json">{JSON.stringify(r.detalle, null, 2)}</pre></td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!ocupado && registros.length === 0 && <tr><td colSpan={5} className="vacio">Sin registros.</td></tr>}
          </tbody>
        </table>
      </div>
      {hayMas && <div style={{ marginTop: 12 }}><button onClick={() => void pedir(registros.at(-1)?.id)} disabled={ocupado}>Ver más</button></div>}
    </>
  );
}
