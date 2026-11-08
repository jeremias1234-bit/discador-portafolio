// Audios de las campañas con mensaje (predictivo con audio e IVR): subir, escuchar, renombrar y borrar.
// El backend los convierte solo al formato de Asterisk (8 kHz, mono, 16 bits).
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Campo, Encabezado, fechaHora, MensajeError, Modal, useAccion, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';

export interface Audio {
  id: number;
  nombre: string;
  archivo: string;
  duracion_seg: number | null;
  creado_en: string;
  campanas: number[] | null;
}

export function SubirAudio({ onCerrar, onSubido }: { onCerrar: () => void; onSubido: (a: Audio) => void }) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [nombre, setNombre] = useState('');
  const { ocupado, error, ejecutar } = useAccion();

  const subir = async (e: FormEvent) => {
    e.preventDefault();
    if (!archivo) return;
    const datos = new FormData();
    if (nombre.trim()) datos.append('nombre', nombre.trim());
    datos.append('archivo', archivo); // al final: el backend lee los campos antes del archivo
    let subido: Audio | null = null;
    if (await ejecutar(async () => { subido = await api.post<Audio>('/api/audios', datos); })) onSubido(subido!);
  };

  return (
    <Modal titulo="Subir audio" onCerrar={onCerrar}>
      <form className="pila" onSubmit={subir} style={{ gap: 14 }}>
        <Campo etiqueta="Archivo" ayuda="MP3, WAV, OGG o FLAC, hasta 30 MB. Se convierte solo al formato telefónico.">
          <input type="file" accept=".mp3,.wav,.ogg,.flac,audio/*" required
            onChange={(e) => {
              const a = e.target.files?.[0] ?? null;
              setArchivo(a);
              if (a && !nombre) setNombre(a.name.replace(/\.[^.]+$/, ''));
            }} />
        </Campo>
        <Campo etiqueta="Nombre" ayuda='Para reconocerlo al elegirlo en la campaña (ej. "Mensaje marca 1 - octubre").'>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={120} />
        </Campo>
        <MensajeError mensaje={error} />
        <div><button className="primario" disabled={ocupado || !archivo}>{ocupado ? 'Convirtiendo…' : 'Subir'}</button></div>
      </form>
    </Modal>
  );
}

export function Audios() {
  const { puede } = useSesion();
  const { datos, error, recargar } = useDatos<Audio[]>('/api/audios');
  const { datos: campanas } = useDatos<{ id: number; nombre: string }[]>('/api/campanas?incluir_archivadas=true');
  const [subir, setSubir] = useState(false);
  const [renombrando, setRenombrando] = useState<Audio | null>(null);
  const accion = useAccion();
  const editable = puede('ivr.audios');
  const nombreCampana = (id: number) => campanas?.find((c) => c.id === id)?.nombre ?? `#${id}`;

  const borrar = async (a: Audio) => {
    if (!confirm(`¿Borrar el audio "${a.nombre}"?`)) return;
    if (await accion.ejecutar(() => api.borrar(`/api/audios/${a.id}`))) void recargar();
  };

  return (
    <>
      <Encabezado titulo="Audios">
        {editable && <button className="primario" onClick={() => setSubir(true)}>Subir audio</button>}
      </Encabezado>
      <div className="alerta info" style={{ marginBottom: 12 }}>
        Son los mensajes que escucha el cliente al atender en las campañas <strong>predictivo con audio</strong> e <strong>IVR</strong>.
        En cada campaña se elige el audio y cómo pasa al vendedor: si marca una tecla (ej. 1), si se queda en línea unos segundos, o cualquiera de las dos.
      </div>
      <MensajeError mensaje={error ?? accion.error} />
      <div className="tabla-envoltura">
        <table className="tabla">
          <thead>
            <tr><th>Nombre</th><th>Escuchar</th><th className="der">Duración</th><th>Lo usan</th><th>Subido</th>{editable && <th></th>}</tr>
          </thead>
          <tbody>
            {(datos ?? []).map((a) => (
              <tr key={a.id}>
                <td><strong>{a.nombre}</strong></td>
                <td><audio controls preload="none" src={`/api/audios/${a.id}/archivo`} style={{ height: 32, maxWidth: 260 }} /></td>
                <td className="der numero">{a.duracion_seg ? `${a.duracion_seg.toFixed(1)} s` : '—'}</td>
                <td>{a.campanas?.length ? a.campanas.map(nombreCampana).join(', ') : <span className="suave">Ninguna campaña</span>}</td>
                <td className="suave">{fechaHora(a.creado_en)}</td>
                {editable && (
                  <td>
                    <div className="fila" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                      <button onClick={() => setRenombrando(a)}>Renombrar</button>
                      <button onClick={() => void borrar(a)} disabled={accion.ocupado || !!a.campanas?.length}
                        title={a.campanas?.length ? 'Lo usa una campaña: cambiá el audio de la campaña primero' : 'Borrar'} aria-label="Borrar">✕</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {datos?.length === 0 && <tr><td colSpan={6} className="vacio">Todavía no hay audios.</td></tr>}
          </tbody>
        </table>
      </div>
      {subir && <SubirAudio onCerrar={() => setSubir(false)} onSubido={() => { setSubir(false); void recargar(); }} />}
      {renombrando && <Renombrar audio={renombrando} onCerrar={() => setRenombrando(null)} onHecho={() => { setRenombrando(null); void recargar(); }} />}
    </>
  );
}

function Renombrar({ audio, onCerrar, onHecho }: { audio: Audio; onCerrar: () => void; onHecho: () => void }) {
  const [nombre, setNombre] = useState(audio.nombre);
  const { ocupado, error, ejecutar } = useAccion();
  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (await ejecutar(() => api.patch(`/api/audios/${audio.id}`, { nombre }))) onHecho();
  };
  return (
    <Modal titulo="Renombrar audio" onCerrar={onCerrar}>
      <form className="pila" onSubmit={guardar} style={{ gap: 14 }}>
        <Campo etiqueta="Nombre"><input value={nombre} onChange={(e) => setNombre(e.target.value)} required maxLength={120} autoFocus /></Campo>
        <MensajeError mensaje={error} />
        <div><button className="primario" disabled={ocupado}>Guardar</button></div>
      </form>
    </Modal>
  );
}
