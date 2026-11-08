// No Llame (§8): padrón oficial (lo descarga la empresa del portal con su inscripción),
// lista propia (agregados a mano, por el vendedor o por tecla del IVR) y consulta de un número.
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Campo, Encabezado, fechaHora, MensajeError, Modal, numero, Pestanas, useAccion, useDatos } from '../componentes/ui';

interface Estado {
  padron_registros: number;
  propia_registros: number;
  dias_desde_ultima_carga: number | null;
  desactualizado: boolean;
  alerta_dias: number;
  ultima_importacion: { archivo: string; estado: string; error: string | null; registros: number | null; fecha_padron: string | null; iniciada_en: string } | null;
}

interface Importacion {
  id: number; archivo: string; fecha_padron: string | null; registros: number | null; estado: string;
  error: string | null; importado_por_nombre: string | null; iniciada_en: string; terminada_en: string | null;
}

interface RegistroPropio {
  telefono: string; fuente: 'manual' | 'vendedor' | 'ivr'; motivo: string | null; usuario_nombre: string | null; creado_en: string;
}

const FUENTE: Record<RegistroPropio['fuente'], string> = { manual: 'Cargado a mano', vendedor: 'Lo pidió al vendedor', ivr: 'Tecla del IVR' };

type Pestana = 'padron' | 'propia' | 'consultar';

export function NoLlame() {
  const { datos: estado, recargar } = useDatos<Estado>('/api/no-llame');
  const [pestana, setPestana] = useState<Pestana>('padron');

  return (
    <>
      <Encabezado titulo="No Llame" />
      {estado && (
        <div className="rejilla" style={{ marginBottom: 16 }}>
          <div className="tarjeta">
            <span className="suave chico">Padrón oficial</span>
            <div className="numero" style={{ fontSize: 24, fontWeight: 700 }}>{numero(estado.padron_registros)}</div>
            {estado.desactualizado
              ? <span className="chip peligro">{estado.dias_desde_ultima_carga === null ? 'Nunca se cargó' : `Cargado hace ${estado.dias_desde_ultima_carga} días`}</span>
              : <span className="chip ok">Cargado hace {estado.dias_desde_ultima_carga} días</span>}
          </div>
          <div className="tarjeta">
            <span className="suave chico">Lista propia</span>
            <div className="numero" style={{ fontSize: 24, fontWeight: 700 }}>{numero(estado.propia_registros)}</div>
            <span className="suave chico">Vendedores, IVR y cargas a mano</span>
          </div>
        </div>
      )}
      <Pestanas opciones={[['padron', 'Padrón oficial'], ['propia', 'Lista propia'], ['consultar', 'Consultar un número']]} actual={pestana} onCambiar={setPestana} />
      {pestana === 'padron' && <Padron onImportado={() => void recargar()} />}
      {pestana === 'propia' && <ListaPropia onCambio={() => void recargar()} />}
      {pestana === 'consultar' && <Consultar />}
    </>
  );
}

function Padron({ onImportado }: { onImportado: () => void }) {
  const { datos, recargar } = useDatos<Importacion[]>('/api/no-llame/importaciones');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [fecha, setFecha] = useState('');
  const [resultado, setResultado] = useState<{ registros: number; anterior: number; invalidas: number; leads_retirados: number } | null>(null);
  const [pedirForzar, setPedirForzar] = useState(false);
  const { ocupado, error, setError, ejecutar } = useAccion();

  const importar = async (forzar: boolean) => {
    if (!archivo) return;
    const datos = new FormData();
    if (fecha) datos.append('fecha_padron', fecha);
    if (forzar) datos.append('forzar', 'true');
    datos.append('archivo', archivo);
    setResultado(null);
    const ok = await ejecutar(async () => setResultado(await api.post('/api/no-llame/padron', datos)));
    void recargar();
    if (ok) {
      setPedirForzar(false);
      onImportado();
    }
  };
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    await importar(false);
  };
  // El backend frena un padrón mucho más chico que el actual (archivo incompleto): se ofrece confirmar
  const esIncompleto = error?.includes('forzar=true');

  return (
    <div className="pila" style={{ gap: 16 }}>
      <form className="tarjeta" onSubmit={enviar}>
        <h2>Importar padrón</h2>
        <div className="suave">Archivo descargado del portal oficial con la inscripción de la empresa: un teléfono por línea (se toma la primera columna). Reemplaza al padrón anterior sin cortar la operación.</div>
        <div className="rejilla">
          <Campo etiqueta="Archivo"><input type="file" accept=".csv,.txt" required onChange={(e) => { setArchivo(e.target.files?.[0] ?? null); setError(null); }} /></Campo>
          <Campo etiqueta="Fecha del padrón" ayuda="Opcional: la que figura en el portal."><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo>
        </div>
        {error && !esIncompleto && <MensajeError mensaje={error} />}
        {esIncompleto && (
          <div className="alerta">
            {error!.replace(' Si es correcto, repetí la importación con forzar=true.', '')}
            <div className="fila" style={{ marginTop: 8 }}>
              <button type="button" className="peligro" onClick={() => setPedirForzar(true)} disabled={ocupado}>Es correcto, importarlo igual</button>
            </div>
          </div>
        )}
        {resultado && (
          <div className="alerta info">
            Padrón aplicado: <strong>{numero(resultado.registros)}</strong> números (antes {numero(resultado.anterior)}).
            {resultado.invalidas > 0 && ` Se saltearon ${numero(resultado.invalidas)} líneas inválidas.`}
            {` Salieron de la cola ${numero(resultado.leads_retirados)} contactos que ahora están en el padrón.`}
          </div>
        )}
        <div><button className="primario" disabled={ocupado || !archivo}>{ocupado ? 'Importando… (puede tardar un minuto)' : 'Importar'}</button></div>
      </form>
      {pedirForzar && (
        <Modal titulo="Confirmar padrón más chico" onCerrar={() => setPedirForzar(false)}>
          <div className="pila" style={{ gap: 12 }}>
            <div>El archivo tiene muchos menos números que el padrón actual. Si lo importás, reemplaza al actual y los números que falten se van a poder llamar.</div>
            <div className="fila">
              <button className="peligro" onClick={() => void importar(true)} disabled={ocupado}>Importar igual</button>
              <button onClick={() => setPedirForzar(false)}>Cancelar</button>
            </div>
          </div>
        </Modal>
      )}
      <section className="tarjeta">
        <h2>Historial</h2>
        <div className="tabla-envoltura">
          <table className="tabla">
            <thead><tr><th>Archivo</th><th>Fecha del padrón</th><th className="der">Números</th><th>Estado</th><th>Por</th><th>Cuándo</th></tr></thead>
            <tbody>
              {(datos ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{i.archivo}</td>
                  <td>{i.fecha_padron ?? '—'}</td>
                  <td className="der numero">{i.registros === null ? '—' : numero(i.registros)}</td>
                  <td>
                    <span className={`chip ${i.estado === 'aplicada' ? 'ok' : i.estado === 'fallida' ? 'peligro' : 'aviso'}`}>{i.estado}</span>
                    {i.error && <div className="suave chico">{i.error}</div>}
                  </td>
                  <td>{i.importado_por_nombre ?? '—'}</td>
                  <td className="suave">{fechaHora(i.iniciada_en)}</td>
                </tr>
              ))}
              {datos?.length === 0 && <tr><td colSpan={6} className="vacio">Todavía no se importó ningún padrón.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ListaPropia({ onCambio }: { onCambio: () => void }) {
  const [buscar, setBuscar] = useState('');
  const { datos, error, recargar } = useDatos<{ total: number; registros: RegistroPropio[] }>(`/api/no-llame/propia?limite=200${buscar ? `&buscar=${buscar}` : ''}`);
  const [telefono, setTelefono] = useState('');
  const [motivo, setMotivo] = useState('');
  const accion = useAccion();

  const agregar = async (e: FormEvent) => {
    e.preventDefault();
    if (await accion.ejecutar(() => api.post('/api/no-llame/propia', { telefono, motivo: motivo || undefined }))) {
      setTelefono('');
      setMotivo('');
      void recargar();
      onCambio();
    }
  };
  const quitar = async (r: RegistroPropio) => {
    if (!confirm(`¿Quitar ${r.telefono} de la lista? Se lo va a poder volver a llamar.`)) return;
    if (await accion.ejecutar(() => api.borrar(`/api/no-llame/propia/${r.telefono}`))) {
      void recargar();
      onCambio();
    }
  };

  return (
    <div className="pila" style={{ gap: 16 }}>
      <form className="tarjeta" onSubmit={agregar}>
        <h2>Agregar un número</h2>
        <div className="fila" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 200px' }}><Campo etiqueta="Teléfono"><input value={telefono} onChange={(e) => setTelefono(e.target.value)} required inputMode="tel" placeholder="Código de área y número" /></Campo></div>
          <div style={{ flex: '2 1 260px' }}><Campo etiqueta="Motivo"><input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} /></Campo></div>
          <button className="primario" disabled={accion.ocupado}>Agregar</button>
        </div>
        <MensajeError mensaje={accion.error} />
      </form>
      <section className="tarjeta">
        <div className="fila separada">
          <h2>Lista propia {datos && <span className="suave">({numero(datos.total)})</span>}</h2>
          <input placeholder="Buscar número" value={buscar} onChange={(e) => setBuscar(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 220 }} inputMode="numeric" />
        </div>
        <MensajeError mensaje={error} />
        <div className="tabla-envoltura">
          <table className="tabla">
            <thead><tr><th>Teléfono</th><th>Origen</th><th>Motivo</th><th>Quién</th><th>Cuándo</th><th></th></tr></thead>
            <tbody>
              {(datos?.registros ?? []).map((r) => (
                <tr key={r.telefono}>
                  <td className="numero">{r.telefono}</td>
                  <td>{FUENTE[r.fuente]}</td>
                  <td>{r.motivo ?? '—'}</td>
                  <td>{r.usuario_nombre ?? '—'}</td>
                  <td className="suave">{fechaHora(r.creado_en)}</td>
                  <td className="der"><button onClick={() => void quitar(r)} disabled={accion.ocupado}>Quitar</button></td>
                </tr>
              ))}
              {datos?.registros.length === 0 && <tr><td colSpan={6} className="vacio">No hay números.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Consultar() {
  const [telefono, setTelefono] = useState('');
  const [r, setR] = useState<{ telefono: string; en_padron: boolean; en_propia: { fuente: RegistroPropio['fuente']; motivo: string | null } | null; bloqueado: boolean } | null>(null);
  const { ocupado, error, ejecutar } = useAccion();
  const consultar = async (e: FormEvent) => {
    e.preventDefault();
    await ejecutar(async () => setR(await api.get(`/api/no-llame/consultar?telefono=${encodeURIComponent(telefono)}`)));
  };
  return (
    <form className="tarjeta" onSubmit={consultar}>
      <div className="fila">
        <input value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="Código de área y número" inputMode="tel" required style={{ maxWidth: 260 }} />
        <button className="primario" disabled={ocupado}>Consultar</button>
      </div>
      <MensajeError mensaje={error} />
      {r && (
        <div className={`alerta ${r.bloqueado ? 'peligro' : 'info'}`}>
          <strong>{r.telefono}</strong>: {r.bloqueado ? 'NO se puede llamar.' : 'se puede llamar.'}
          {r.en_padron && ' Está en el padrón oficial.'}
          {r.en_propia && ` Está en la lista propia (${FUENTE[r.en_propia.fuente]}${r.en_propia.motivo ? `: ${r.en_propia.motivo}` : ''}).`}
        </div>
      )}
    </form>
  );
}
