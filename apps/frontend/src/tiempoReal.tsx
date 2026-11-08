// WebSocket /api/ws: una sola conexión por pestaña, con reconexión automática.
// Los componentes se suscriben por canal ('puesto', 'monitor').
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type Oyente = (mensaje: { canal: string; [k: string]: unknown }) => void;

interface ContextoTiempoReal {
  conectado: boolean;
  suscribir: (canal: string, oyente: Oyente) => () => void;
  /** Se llama cada vez que la conexión se (re)abre (y enseguida si ya está abierta): sirve para recargar el estado completo. */
  alConectar: (fn: () => void) => () => void;
}

const Contexto = createContext<ContextoTiempoReal | null>(null);

const ESPERA_MIN_MS = 1000;
const ESPERA_MAX_MS = 15_000;

export function ProveedorTiempoReal({ children }: { children: ReactNode }) {
  const [conectado, setConectado] = useState(false);
  const oyentes = useRef(new Map<string, Set<Oyente>>());
  const alAbrir = useRef(new Set<() => void>());
  const abierto = useRef(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let espera = ESPERA_MIN_MS;
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    let cerrado = false;

    const abrir = () => {
      const protocolo = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${protocolo}://${location.host}/api/ws`);
      ws.onopen = () => {
        espera = ESPERA_MIN_MS;
        abierto.current = true;
        setConectado(true);
        for (const fn of alAbrir.current) fn();
      };
      ws.onmessage = (e) => {
        let mensaje: { canal: string };
        try {
          mensaje = JSON.parse(String(e.data));
        } catch {
          return;
        }
        for (const o of oyentes.current.get(mensaje.canal) ?? []) o(mensaje);
      };
      ws.onclose = () => {
        abierto.current = false;
        setConectado(false);
        if (cerrado) return;
        temporizador = setTimeout(abrir, espera);
        espera = Math.min(espera * 2, ESPERA_MAX_MS);
      };
    };
    abrir();
    return () => {
      cerrado = true;
      clearTimeout(temporizador);
      ws?.close();
    };
  }, []);

  // Funciones estables: los efectos que se suscriben no se rehacen en cada reconexión
  const funciones = useMemo(
    () => ({
      suscribir: (canal: string, oyente: Oyente) => {
        if (!oyentes.current.has(canal)) oyentes.current.set(canal, new Set());
        oyentes.current.get(canal)!.add(oyente);
        return () => void oyentes.current.get(canal)?.delete(oyente);
      },
      alConectar: (fn: () => void) => {
        alAbrir.current.add(fn);
        if (abierto.current) fn();
        return () => void alAbrir.current.delete(fn);
      },
    }),
    [],
  );
  const valor = useMemo<ContextoTiempoReal>(() => ({ conectado, ...funciones }), [conectado, funciones]);
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useTiempoReal(): ContextoTiempoReal {
  const c = useContext(Contexto);
  if (!c) throw new Error('useTiempoReal fuera de ProveedorTiempoReal');
  return c;
}
