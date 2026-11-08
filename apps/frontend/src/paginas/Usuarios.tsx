// Usuarios (§14): vendedores, supervisores y admins; alta, edición, baja, clave y permisos individuales.
import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Campo, Encabezado, fechaHora, Interruptor, MensajeError, Modal, Pestanas, useAccion, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import type { Rol } from '../tipos';

interface Usuario {
  id: number;
  nombre: string;
  usuario: string;
  rol: Rol;
  sede_id: number | null;
  interno_sip: string | null;
  tipo_telefono: 'navegador' | 'externo';
  puede_marcar_manual: boolean;
  recibe_ivr: boolean;
  tope_llamadas: number | null;
  activo: boolean;
  ultimo_acceso: string | null;
}

interface Detalle extends Usuario {
  excepciones_permisos: { permiso: string; concedido: boolean }[];
  permisos: string[];
}

interface Permiso {
  codigo: string;
  area: string;
  descripcion: string;
  roles: Rol[] | null;
}

interface Sede {
  id: number;
  nombre: string;
}

export const ROLES: [Rol, string][] = [['vendedor', 'Vendedor'], ['supervisor', 'Supervisor'], ['admin', 'Administrador']];
const NOMBRE_ROL = Object.fromEntries(ROLES) as Record<Rol, string>;

export function Usuarios() {
  const { puede } = useSesion();
  const [filtroRol, setFiltroRol] = useState<Rol | ''>('');
  const [verBajas, setVerBajas] = useState(false);
  const [buscar, setBuscar] = useState('');
  const [editando, setEditando] = useState<number | Rol | null>(null);
  const ruta = `/api/usuarios?incluir_bajas=${verBajas}${filtroRol ? `&rol=${filtroRol}` : ''}`;
  const { datos, error, recargar } = useDatos<Usuario[]>(ruta);
  const { datos: sedes } = useDatos<Sede[]>('/api/sedes');

  const lista = useMemo(() => {
    const t = buscar.trim().toLowerCase();
    return (datos ?? []).filter((u) => !t || u.nombre.toLowerCase().includes(t) || u.usuario.includes(t) || u.interno_sip?.includes(t));
  }, [datos, buscar]);

  return (
    <>
      <Encabezado titulo="Usuarios">
        {puede('vendedores.editar', 'usuarios.administrar') && <button className="primario" onClick={() => setEditando('vendedor')}>Nuevo vendedor</button>}
        {puede('usuarios.administrar') && <button onClick={() => setEditando('supervisor')}>Nuevo supervisor</button>}
        {puede('usuarios.administrar') && <button onClick={() => setEditando('admin')}>Nuevo administrador</button>}
      </Encabezado>
      <div className="fila" style={{ marginBottom: 12 }}>
        <input placeholder="Buscar por nombre, usuario o interno" value={buscar} onChange={(e) => setBuscar(e.target.value)} style={{ maxWidth: 320 }} />
        {puede('usuarios.administrar') && (
          <select value={filtroRol} onChange={(e) => setFiltroRol(e.target.value as Rol | '')} style={{ width: 'auto' }}>
            <option value="">Todos los roles</option>
            {ROLES.map(([r, t]) => <option key={r} value={r}>{t}</option>)}
          </select>
        )}
        <Interruptor etiqueta="Mostrar dados de baja" valor={verBajas} onCambiar={setVerBajas} />
      </div>
      <MensajeError mensaje={error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead>
            <tr>
              <th>Nombre</th><th>Usuario</th><th>Rol</th><th>Interno</th><th>Teléfono</th><th>Manual</th><th>IVR</th><th>Último acceso</th><th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((u) => (
              <tr key={u.id} className={`clic ${u.activo ? '' : 'inactivo'}`} onClick={() => setEditando(u.id)}>
                <td><strong>{u.nombre}</strong></td>
                <td>{u.usuario}</td>
                <td>{NOMBRE_ROL[u.rol]}</td>
                <td className="numero">{u.interno_sip ?? '—'}</td>
                <td>{u.tipo_telefono === 'navegador' ? 'Navegador' : 'Externo'}</td>
                <td>{u.puede_marcar_manual ? 'Sí' : 'No'}</td>
                <td>{u.recibe_ivr ? 'Sí' : 'No'}</td>
                <td className="suave">{fechaHora(u.ultimo_acceso)}</td>
                <td>{u.activo ? <span className="chip ok">Activo</span> : <span className="chip">Baja</span>}</td>
              </tr>
            ))}
            {datos && lista.length === 0 && (
              <tr><td colSpan={9} className="vacio">No hay usuarios con ese filtro.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {editando !== null && (
        <EditorUsuario
          id={typeof editando === 'number' ? editando : null}
          rolNuevo={typeof editando === 'string' ? editando : 'vendedor'}
          sedes={sedes ?? []}
          onCerrar={() => setEditando(null)}
          onCambio={() => void recargar()}
        />
      )}
    </>
  );
}

type Pestana = 'datos' | 'permisos' | 'clave';

function EditorUsuario({ id, rolNuevo, sedes, onCerrar, onCambio }: { id: number | null; rolNuevo: Rol; sedes: Sede[]; onCerrar: () => void; onCambio: () => void }) {
  const { yo, puede } = useSesion();
  const { datos: detalle, error: errorCarga, recargar } = useDatos<Detalle>(id ? `/api/usuarios/${id}` : null);
  const [pestana, setPestana] = useState<Pestana>('datos');
  const esYo = id === yo?.id;

  if (id && !detalle) {
    return <Modal titulo="Usuario" onCerrar={onCerrar}>{errorCarga ? <MensajeError mensaje={errorCarga} /> : <div className="suave">Cargando…</div>}</Modal>;
  }

  const opciones: [Pestana, string][] = [['datos', 'Datos']];
  if (detalle && puede('usuarios.permisos') && !esYo) opciones.push(['permisos', 'Permisos']);
  if (detalle && !esYo) opciones.push(['clave', 'Clave y baja']);

  return (
    <Modal titulo={detalle ? detalle.nombre : `Nuevo ${NOMBRE_ROL[rolNuevo].toLowerCase()}`} onCerrar={onCerrar} ancho={720}>
      {opciones.length > 1 && <Pestanas opciones={opciones} actual={pestana} onCambiar={setPestana} />}
      {pestana === 'datos' && (
        <DatosUsuario
          detalle={detalle} sedes={sedes} rolNuevo={rolNuevo}
          onGuardado={(nuevo) => {
            onCambio();
            if (nuevo) onCerrar();
            else void recargar();
          }}
        />
      )}
      {pestana === 'permisos' && detalle && <PermisosUsuario detalle={detalle} onGuardado={() => void recargar()} />}
      {pestana === 'clave' && detalle && <ClaveYBaja detalle={detalle} onCambio={() => { onCambio(); void recargar(); }} onBorrado={() => { onCambio(); onCerrar(); }} />}
    </Modal>
  );
}

const DESCRIPCION_ROL: Record<Rol, string> = {
  vendedor: 'Atiende llamadas desde el puesto.',
  supervisor: 'Ve el monitor, escucha llamadas y ve reportes. Se le pueden sumar permisos.',
  admin: 'Tiene todas las funciones: campañas, bases, usuarios, IVR y configuración.',
};

function DatosUsuario({ detalle, sedes, rolNuevo, onGuardado }: { detalle: Detalle | null; sedes: Sede[]; rolNuevo: Rol; onGuardado: (nuevo: boolean) => void }) {
  const { puede } = useSesion();
  const [f, setF] = useState({
    nombre: detalle?.nombre ?? '',
    usuario: detalle?.usuario ?? '',
    rol: detalle?.rol ?? rolNuevo,
    sede_id: detalle?.sede_id ?? null,
    tipo_telefono: detalle?.tipo_telefono ?? ('navegador' as const),
    puede_marcar_manual: detalle?.puede_marcar_manual ?? rolNuevo === 'vendedor',
    recibe_ivr: detalle?.recibe_ivr ?? false,
    tope_llamadas: detalle?.tope_llamadas ?? null,
    clave: '',
  });
  const { ocupado, error, ejecutar } = useAccion();
  const [guardado, setGuardado] = useState(false);
  const cambiar = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setGuardado(false);
  };
  // Sin 'usuarios.administrar' solo se gestionan vendedores
  const roles = puede('usuarios.administrar') ? ROLES : ROLES.filter(([r]) => r === 'vendedor');

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    const { clave, ...resto } = f;
    const ok = await ejecutar(async () => {
      if (detalle) await api.patch(`/api/usuarios/${detalle.id}`, resto);
      else await api.post('/api/usuarios', { ...resto, clave });
    });
    if (ok) {
      setGuardado(true);
      onGuardado(!detalle);
    }
  };

  return (
    <form className="pila" onSubmit={guardar} style={{ gap: 14 }}>
      <div className="rejilla">
        <Campo etiqueta="Nombre y apellido">
          <input value={f.nombre} onChange={(e) => cambiar('nombre', e.target.value)} required maxLength={100} />
        </Campo>
        <Campo etiqueta="Usuario" ayuda="Para entrar al panel. Letras, números, punto o guion.">
          <input value={f.usuario} onChange={(e) => cambiar('usuario', e.target.value.toLowerCase())} required pattern="[a-z0-9._\-]{3,32}" />
        </Campo>
        <Campo etiqueta="Rol" ayuda={DESCRIPCION_ROL[f.rol]}>
          <select value={f.rol} onChange={(e) => cambiar('rol', e.target.value as Rol)}>
            {roles.map(([r, t]) => <option key={r} value={r}>{t}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="Sede">
          <select value={f.sede_id ?? ''} onChange={(e) => cambiar('sede_id', e.target.value ? Number(e.target.value) : null)}>
            <option value="">Sin sede</option>
            {sedes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
        </Campo>
        {!detalle && (
          <Campo etiqueta="Clave inicial" ayuda="Mínimo 8 caracteres. El usuario la puede cambiar después.">
            <input type="text" value={f.clave} onChange={(e) => cambiar('clave', e.target.value)} required minLength={8} autoComplete="off" />
          </Campo>
        )}
      </div>
      <div className="seccion">
        <h3>Teléfono</h3>
        <div className="rejilla">
          <Campo etiqueta="Tipo de teléfono">
            <select value={f.tipo_telefono} onChange={(e) => cambiar('tipo_telefono', e.target.value as 'navegador' | 'externo')}>
              <option value="navegador">Navegador (softphone del panel)</option>
              <option value="externo">Externo (MicroSIP o teléfono IP)</option>
            </select>
          </Campo>
          <Campo etiqueta="Interno">
            <input value={detalle?.interno_sip ?? 'Se asigna solo al guardar'} disabled />
          </Campo>
          <Campo etiqueta="Tope de llamadas simultáneas" ayuda="Solo predictivo. Vacío = el ritmo de la campaña.">
            <input type="number" min={0.1} max={99} step={0.1} value={f.tope_llamadas ?? ''}
              onChange={(e) => cambiar('tope_llamadas', e.target.value ? Number(e.target.value) : null)} />
          </Campo>
        </div>
        <Interruptor etiqueta="Puede marcar a mano" valor={f.puede_marcar_manual} onCambiar={(v) => cambiar('puede_marcar_manual', v)} />
        <Interruptor etiqueta="Recibe llamadas del IVR" ayuda="Le pueden llegar los clientes que pasan del mensaje pregrabado."
          valor={f.recibe_ivr} onCambiar={(v) => cambiar('recibe_ivr', v)} deshabilitado={!puede('vendedores.ivr')} />      </div>
      <MensajeError mensaje={error} />
      <div className="fila">
        <button className="primario" disabled={ocupado}>{detalle ? 'Guardar cambios' : 'Crear usuario'}</button>
        {guardado && <span className="chip ok">Guardado</span>}
      </div>
    </form>
  );
}

type Eleccion = 'rol' | 'si' | 'no';

function PermisosUsuario({ detalle, onGuardado }: { detalle: Detalle; onGuardado: () => void }) {
  const { yo } = useSesion();
  const { datos: catalogo, error: errorCarga } = useDatos<Permiso[]>('/api/permisos');
  const [elecciones, setElecciones] = useState<Record<string, Eleccion>>(() =>
    Object.fromEntries(detalle.excepciones_permisos.map((e) => [e.permiso, e.concedido ? 'si' : 'no'])),
  );
  const { ocupado, error, ejecutar } = useAccion();
  const [guardado, setGuardado] = useState(false);

  const areas = useMemo(() => {
    const m = new Map<string, Permiso[]>();
    for (const p of catalogo ?? []) {
      if (!m.has(p.area)) m.set(p.area, []);
      m.get(p.area)!.push(p);
    }
    return [...m];
  }, [catalogo]);

  if (!catalogo) return errorCarga ? <MensajeError mensaje={errorCarga} /> : <div className="suave">Cargando…</div>;

  const guardar = async () => {
    const excepciones = Object.entries(elecciones)
      .filter(([, v]) => v !== 'rol')
      .map(([permiso, v]) => ({ permiso, concedido: v === 'si' }));
    if (await ejecutar(() => api.put(`/api/usuarios/${detalle.id}/permisos`, { excepciones }))) {
      setGuardado(true);
      onGuardado();
    }
  };

  return (
    <div className="pila" style={{ gap: 14 }}>
      <div className="alerta info">
        Por defecto vale lo que tiene el rol ({NOMBRE_ROL[detalle.rol]}). Acá se agregan o quitan permisos solo para este usuario.
      </div>
      {areas.map(([area, permisos]) => (
        <div key={area} className="permisos-area">
          <h3>{area}</h3>
          {permisos.map((p) => {
            const porRol = !!p.roles?.includes(detalle.rol);
            const eleccion = elecciones[p.codigo] ?? 'rol';
            const efectivo = eleccion === 'rol' ? porRol : eleccion === 'si';
            const loTengo = !!yo?.permisos.includes(p.codigo);
            return (
              <div key={p.codigo} className={`permiso ${eleccion !== 'rol' ? 'cambiado' : ''}`}>
                <div>
                  <div>{p.descripcion}</div>
                  <small className={efectivo ? '' : 'suave'} style={efectivo ? { color: 'var(--ok)' } : undefined}>
                    {efectivo ? 'Lo tiene' : 'No lo tiene'}
                  </small>
                </div>
                <select
                  value={eleccion} disabled={!loTengo}
                  title={loTengo ? undefined : 'No podés asignar un permiso que no tenés'}
                  onChange={(e) => {
                    setElecciones((x) => ({ ...x, [p.codigo]: e.target.value as Eleccion }));
                    setGuardado(false);
                  }}
                >
                  <option value="rol">Según el rol ({porRol ? 'sí' : 'no'})</option>
                  <option value="si">Dar</option>
                  <option value="no">Quitar</option>
                </select>
              </div>
            );
          })}
        </div>
      ))}
      <MensajeError mensaje={error} />
      <div className="fila">
        <button className="primario" onClick={() => void guardar()} disabled={ocupado}>Guardar permisos</button>
        {guardado && <span className="chip ok">Guardado</span>}
      </div>
    </div>
  );
}

function ClaveYBaja({ detalle, onCambio, onBorrado }: { detalle: Detalle; onCambio: () => void; onBorrado: () => void }) {
  const [clave, setClave] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const { ocupado, error, ejecutar } = useAccion();

  const blanquear = async (e: FormEvent) => {
    e.preventDefault();
    if (await ejecutar(() => api.post(`/api/usuarios/${detalle.id}/clave`, { clave }))) {
      setClave('');
      setAviso('Clave cambiada. Se cerraron sus sesiones abiertas.');
    }
  };
  const baja = async () => {
    if (!confirm(`¿Dar de baja a ${detalle.nombre}? No va a poder entrar, pero se conservan sus llamadas.`)) return;
    if (await ejecutar(() => api.post(`/api/usuarios/${detalle.id}/baja`))) onCambio();
  };
  const reactivar = async () => {
    if (await ejecutar(() => api.post(`/api/usuarios/${detalle.id}/reactivar`))) onCambio();
  };
  const borrar = async () => {
    if (!confirm(`¿Borrar definitivamente a ${detalle.nombre}? Solo se puede si nunca tuvo llamadas.`)) return;
    if (await ejecutar(() => api.borrar(`/api/usuarios/${detalle.id}`))) onBorrado();
  };

  return (
    <div className="pila" style={{ gap: 16 }}>
      <form className="seccion" onSubmit={blanquear}>
        <h3>Nueva clave</h3>
        <div className="fila">
          <input type="text" value={clave} onChange={(e) => setClave(e.target.value)} minLength={8} required placeholder="Mínimo 8 caracteres" autoComplete="off" style={{ maxWidth: 300 }} />
          <button disabled={ocupado}>Cambiar clave</button>
        </div>
        {aviso && <div className="alerta info">{aviso}</div>}
      </form>
      <div className="seccion">
        <h3>Estado</h3>
        <div className="fila">
          {detalle.activo ? (
            <button className="peligro" onClick={() => void baja()} disabled={ocupado}>Dar de baja</button>
          ) : (
            <button className="ok" onClick={() => void reactivar()} disabled={ocupado}>Reactivar</button>
          )}
          <button onClick={() => void borrar()} disabled={ocupado}>Borrar definitivamente</button>
        </div>
      </div>
      <MensajeError mensaje={error} />
    </div>
  );
}
