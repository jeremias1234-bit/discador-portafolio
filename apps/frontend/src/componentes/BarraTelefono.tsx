// Estado del softphone y de la línea, con los controles de audio.
import { useState } from 'react';
import { api, mensajeDeError } from '../api';
import { useTelefono } from '../telefono/contexto';
import type { EstadoRegistro } from '../telefono/softphone';

const REGISTRO: Record<EstadoRegistro, [string, string]> = {
  apagado: ['Teléfono apagado', ''],
  conectando: ['Conectando teléfono…', 'aviso'],
  registrado: ['Teléfono listo', 'ok'],
  sin_conexion: ['Teléfono sin conexión', 'peligro'],
  rechazado: ['Interno rechazado', 'peligro'],
};

export function BarraTelefono({ lineaEnServidor, interno }: { lineaEnServidor: boolean; interno: string | null }) {
  const { softphone, estado } = useTelefono();
  const [prueba, setPrueba] = useState<string | null>(null);

  if (!softphone || !estado) {
    return (
      <div className="fila">
        <span className={`chip ${lineaEnServidor ? 'ok' : 'peligro'}`}>{lineaEnServidor ? 'Línea abierta' : 'Línea cerrada'}</span>
        {!lineaEnServidor && (
          <span className="suave">
            {interno ? `Teléfono externo: marcá 9000 desde el interno ${interno} para abrir la línea.` : 'No tenés interno asignado.'}
          </span>
        )}
      </div>
    );
  }

  const [textoRegistro, claseRegistro] = REGISTRO[estado.registro];
  return (
    <div className="pila">
      <div className="fila">
        <span className={`chip ${claseRegistro}`}>{textoRegistro}</span>
        {estado.linea === 'abierta' || lineaEnServidor ? (
          <>
            <span className="chip ok">Línea abierta</span>
            <button onClick={() => softphone.cerrarLinea()} title="Dejás de recibir llamadas">
              Cerrar línea
            </button>
          </>
        ) : (
          <button
            className="primario"
            disabled={estado.registro !== 'registrado' || estado.linea === 'abriendo'}
            onClick={() => softphone.abrirLinea()}
          >
            {estado.linea === 'abriendo' ? 'Abriendo línea…' : 'Conectar línea'}
          </button>
        )}
        <button
          className={estado.silenciado ? 'peligro' : ''}
          onClick={() => softphone.silenciar(!estado.silenciado)}
          title="El cliente no te escucha"
        >
          {estado.silenciado ? 'Micrófono silenciado' : 'Silenciar'}
        </button>
        <button
          title="Con la línea abierta, el servidor te manda 3 s de tono por el mismo camino que la voz del cliente"
          onClick={async () => {
            setPrueba(null);
            softphone.activarAudio();
            if (estado.linea === 'abierta' || lineaEnServidor) {
              try {
                await api.post('/api/puesto/probar-audio');
                setPrueba('Tendrías que escuchar 3 s de tono ("tuuu"). Si no suena, revisá la salida de audio de la PC.');
              } catch (err) {
                setPrueba(mensajeDeError(err));
              }
            } else {
              const ok = await softphone.probarAudioLocal();
              setPrueba(ok ? 'Tendrías que haber escuchado un tono de 1 s.' : 'El navegador bloqueó el audio: tocá "Activar audio".');
            }
          }}
        >
          Probar audio
        </button>
        <label className="fila" style={{ gap: 6, fontWeight: 400 }}>
          <span>Volumen</span>
          <input
            type="range" min={0} max={1} step={0.05} value={estado.volumen} style={{ width: 100 }}
            onChange={(e) => softphone.fijarVolumen(Number(e.target.value))}
          />
        </label>
      </div>
      {estado.audioBloqueado && (
        <div className="alerta peligro fila separada">
          <span>El navegador bloqueó el audio de esta página: no vas a escuchar a los clientes.</span>
          <button className="primario" onClick={() => softphone.activarAudio()}>Activar audio</button>
        </div>
      )}
      {prueba && <div className="alerta info">{prueba}</div>}
      {estado.error && <div className="alerta">{estado.error}</div>}
    </div>
  );
}
