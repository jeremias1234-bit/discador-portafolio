// Comparación de los audios de una campaña (A y B): de los que empezaron a escuchar el mensaje,
// cuántos cortaron, cuántos llegaron al final y cuántos marcaron, con el % de cada paso.
import { useState } from 'react';
import { MensajeError, numero, useDatos } from './ui';

interface FilaAudio {
  audio_id: number;
  nombre: string | null;
  duracion_seg: number | null;
  escucharon: number;
  cortaron: number;
  llegaron_al_final: number;
  marcaron: number;
  llamada: number;
  whatsapp: number;
  sin_marcar: number;
  no_llame: number;
  seg_hasta_cortar: number | null;
}

/** Por debajo de esto la diferencia entre audios puede ser casualidad: se avisa. */
const MUESTRA_MINIMA = 300;

const hoyLocal = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD
const pct = (n: number, de: number) => (de ? `${((100 * n) / de).toLocaleString('es-AR', { maximumFractionDigits: 1 })} %` : '—');

export function ComparacionAudios({ campanaId, audioA, audioB, pctB }: {
  campanaId: number; audioA: number | null; audioB: number | null; pctB: number;
}) {
  const [rango, setRango] = useState({ desde: hoyLocal(), hasta: hoyLocal() });
  const { datos, error } = useDatos<FilaAudio[]>(`/api/campanas/${campanaId}/audios?desde=${rango.desde}&hasta=${rango.hasta}`);
  const filas = datos ?? [];
  const letra = (id: number) => (id === audioA ? 'A' : id === audioB ? 'B' : null);
  const chica = filas.some((f) => f.escucharon < MUESTRA_MINIMA);

  return (
    <div className="pila" style={{ gap: 8 }}>
      <div className="fila separada">
        <span className="suave chico">
          {audioB && pctB > 0 ? `Reparto actual: ${100 - pctB} % con el A y ${pctB} % con el B.` : 'La campaña tiene un solo audio.'}
          {' '}Los % son sobre los que empezaron a escuchar el mensaje.
        </span>
        <div className="fila filtros">
          <label>Desde <input type="date" value={rango.desde} onChange={(e) => setRango({ ...rango, desde: e.target.value })} /></label>
          <label>Hasta <input type="date" value={rango.hasta} onChange={(e) => setRango({ ...rango, hasta: e.target.value })} /></label>
        </div>
      </div>
      <MensajeError mensaje={error} />
      <table className="tabla compacta">
        <thead>
          <tr>
            <th>Audio</th><th className="der">Escucharon</th><th className="der">Cortaron</th><th className="der">Llegaron al final</th>
            <th className="der">Marcaron</th><th className="der">📞 Llamada</th><th className="der">💬 WhatsApp</th><th className="der">Cortan a los</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.audio_id}>
              <td>
                {letra(f.audio_id) && <span className="chip info">{letra(f.audio_id)}</span>} {f.nombre ?? `audio ${f.audio_id}`}
                {!letra(f.audio_id) && <span className="suave chico"> (ya no está en la campaña)</span>}
              </td>
              <td className="der numero">{numero(f.escucharon)}</td>
              <td className="der numero">{numero(f.cortaron)} <span className="suave chico">{pct(f.cortaron, f.escucharon)}</span></td>
              <td className="der numero">{numero(f.llegaron_al_final)} <span className="suave chico">{pct(f.llegaron_al_final, f.escucharon)}</span></td>
              <td className="der numero"><strong>{numero(f.marcaron)}</strong> <span className="suave chico">{pct(f.marcaron, f.escucharon)}</span></td>
              <td className="der numero">{numero(f.llamada)}</td>
              <td className="der numero">{numero(f.whatsapp)}</td>
              <td className="der numero">{f.seg_hasta_cortar === null ? '—' : `${f.seg_hasta_cortar.toLocaleString('es-AR')} s`}</td>
            </tr>
          ))}
          {datos && filas.length === 0 && <tr><td colSpan={8} className="vacio">Todavía no hay llamadas que hayan escuchado el mensaje en estas fechas.</td></tr>}
        </tbody>
      </table>
      {chica && (
        <small className="suave chico">
          Con menos de {MUESTRA_MINIMA} llamadas por audio la diferencia puede ser casualidad: conviene juntar varios días antes de decidir.
        </small>
      )}
    </div>
  );
}
