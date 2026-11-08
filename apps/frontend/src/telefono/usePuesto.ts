// Estado del puesto del vendedor: combina GET /api/puesto con los eventos del WebSocket.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useTiempoReal } from '../tiempoReal';
import type { EstadoDelPuesto, Ficha, MensajePuesto, Pendiente } from '../tipos';
import { tonoDeEntrada } from './softphone';

/** Llamada que terminó y espera tipificación. La ficha falta si se recargó la página. */
export interface PorTipificar {
  llamada_id: number;
  ficha: Ficha | null;
  obligatoria: boolean;
  /** Para mostrar algo cuando no hay ficha (llamada elegida de los pendientes). */
  telefono?: string;
}

export function usePuesto(volumen: number) {
  const { suscribir, alConectar } = useTiempoReal();
  const [puesto, setPuesto] = useState<EstadoDelPuesto | null>(null);
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [inicioLlamada, setInicioLlamada] = useState<number | null>(null);
  const [porTipificar, setPorTipificar] = useState<PorTipificar | null>(null);
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  // Llamada manual que todavía no atendieron (suena): la ficha llega recién al atender
  const [marcando, setMarcando] = useState<{ llamada_id: number; telefono: string; desde: number } | null>(null);
  const volumenRef = useRef(volumen);
  volumenRef.current = volumen;
  const puestoRef = useRef(puesto);
  puestoRef.current = puesto;
  const fichaRef = useRef(ficha);
  fichaRef.current = ficha;
  // Llamadas que ya terminaron: si falla al instante, el aviso llega antes que la respuesta de /llamar
  const terminadas = useRef(new Set<number>());

  const cargarPendientes = useCallback(async () => {
    setPendientes(await api.get<Pendiente[]>('/api/puesto/pendientes').catch(() => []));
  }, []);

  const recargar = useCallback(async () => {
    const p = await api.get<EstadoDelPuesto>('/api/puesto');
    setPuesto(p);
    if (!p.llamada_id) setFicha(null);
    // Recarga en pleno "tipificando": se recupera la llamada aunque no haya ficha
    if (p.estado === 'tipificando' && p.ultima_llamada_id) {
      setPorTipificar((actual) =>
        actual?.llamada_id === p.ultima_llamada_id ? actual : { llamada_id: p.ultima_llamada_id!, ficha: null, obligatoria: true },
      );
    }
    await cargarPendientes();
  }, [cargarPendientes]);

  useEffect(() => alConectar(() => void recargar().catch(() => {})), [alConectar, recargar]);

  useEffect(
    () =>
      suscribir('puesto', (m) => {
        const msj = m as unknown as MensajePuesto;
        switch (msj.tipo) {
          case 'hola':
            break;
          case 'linea':
            setPuesto((p) => p && {
              ...p, linea_conectada: msj.conectada, estado: msj.conectada ? (msj.estado ?? p.estado) : null,
              desde: msj.conectada ? Date.now() : null,
            });
            if (!msj.conectada) setFicha(null);
            break;
          case 'estado':
            setPuesto((p) => p && { ...p, estado: msj.estado, motivo_descanso_id: msj.motivo_descanso_id, desde: Date.now() });
            break;
          case 'llamada_conectada':
            setMarcando(null);
            setFicha(msj.ficha);
            setInicioLlamada(Date.now());
            // Una tipificación opcional que quedó sin hacer pasa a los pendientes
            setPorTipificar(null);
            setPuesto((p) => p && { ...p, llamada_id: msj.ficha.llamada_id });
            if (puestoRef.current?.tono_entrada) tonoDeEntrada(volumenRef.current);
            break;
          case 'llamada_terminada': {
            terminadas.current.add(msj.llamada_id);
            setMarcando((x) => (x?.llamada_id === msj.llamada_id ? null : x));
            const f = fichaRef.current?.llamada_id === msj.llamada_id ? fichaRef.current : null;
            if (msj.conectada) setPorTipificar({ llamada_id: msj.llamada_id, ficha: f, obligatoria: msj.debe_tipificar });
            if (f) setFicha(null);
            setInicioLlamada(null);
            setPuesto((p) => p && { ...p, llamada_id: null, ultima_llamada_id: msj.llamada_id });
            void cargarPendientes();
            break;
          }
        }
      }),
    [suscribir, cargarPendientes],
  );

  const acciones = {
    disponible: () => api.post('/api/puesto/estado', { estado: 'disponible' }),
    descanso: (motivo_descanso_id: number) => api.post('/api/puesto/estado', { estado: 'descanso', motivo_descanso_id }),
    colgar: () => api.post('/api/puesto/colgar'),
    llamar: async (telefono: string, lead_id?: number) => {
      const r = await api.post<{ ok: boolean; llamada_id: number; telefono: string }>('/api/puesto/llamar', { telefono, lead_id });
      // Si ya atendió (llegó la ficha antes que esta respuesta), no se muestra "llamando"
      if (fichaRef.current?.llamada_id !== r.llamada_id && !terminadas.current.has(r.llamada_id)) setMarcando({ llamada_id: r.llamada_id, telefono: r.telefono, desde: Date.now() });
      return r;
    },
    tipificar: async (datos: { llamada_id: number; tipificacion_id: number; notas?: string; reintentar_en_min?: number }) => {
      await api.post('/api/puesto/tipificar', datos);
      setPorTipificar((p) => (p?.llamada_id === datos.llamada_id ? null : p));
      await cargarPendientes();
    },
    descartarTipificacion: () => setPorTipificar(null),
  };

  return { puesto, ficha, marcando, inicioLlamada, porTipificar, setPorTipificar, pendientes, recargar, acciones };
}
