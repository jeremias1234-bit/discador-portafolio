// Piezas de interfaz compartidas por las pantallas de administración.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, mensajeDeError } from '../api';

/** GET con estado de carga y error; recargar() vuelve a pedir. */
export function useDatos<T>(ruta: string | null) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  const recargar = useCallback(async () => {
    if (!ruta) return;
    setCargando(true);
    try {
      setDatos(await api.get<T>(ruta));
      setError(null);
    } catch (err) {
      setError(mensajeDeError(err));
    } finally {
      setCargando(false);
    }
  }, [ruta]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  return { datos, error, cargando, recargar, setDatos };
}

/** Ejecuta una acción mostrando "ocupado" y el error si falla. Devuelve true si salió bien. */
export function useAccion() {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ejecutar = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setOcupado(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(mensajeDeError(err));
      return false;
    } finally {
      setOcupado(false);
    }
  }, []);
  return { ocupado, error, setError, ejecutar };
}

export function Modal({ titulo, onCerrar, children, ancho = 560 }: { titulo: string; onCerrar: () => void; children: ReactNode; ancho?: number }) {
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [onCerrar]);
  // Portal: el modal puede abrirse desde adentro de un formulario (ej. subir un audio desde la
  // campaña) y no debe quedar anidado en él; el submit tampoco tiene que llegar al de afuera.
  return createPortal(
    <div className="modal-fondo" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()} onSubmit={(e) => e.stopPropagation()}>
      <div className="modal tarjeta" style={{ width: `min(${ancho}px, 100%)` }} role="dialog" aria-label={titulo}>
        <div className="fila separada">
          <h2>{titulo}</h2>
          <button type="button" className="cerrar" onClick={onCerrar} aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Pestanas<T extends string>({ opciones, actual, onCambiar }: { opciones: [T, string][]; actual: T; onCambiar: (t: T) => void }) {
  return (
    <div className="pestanas" role="tablist">
      {opciones.map(([clave, texto]) => (
        <button key={clave} role="tab" aria-selected={clave === actual} className={clave === actual ? 'activa' : ''} onClick={() => onCambiar(clave)}>
          {texto}
        </button>
      ))}
    </div>
  );
}

export function Campo({ etiqueta, ayuda, children }: { etiqueta: string; ayuda?: string; children: ReactNode }) {
  return (
    <div className="campo">
      <label>
        <span>{etiqueta}</span>
        {children}
      </label>
      {ayuda && <small className="suave chico">{ayuda}</small>}
    </div>
  );
}

export function Interruptor({ etiqueta, ayuda, valor, onCambiar, deshabilitado }: {
  etiqueta: string; ayuda?: string; valor: boolean; onCambiar: (v: boolean) => void; deshabilitado?: boolean;
}) {
  return (
    <label className="interruptor">
      <input type="checkbox" checked={valor} onChange={(e) => onCambiar(e.target.checked)} disabled={deshabilitado} />
      <div>
        <div>{etiqueta}</div>
        {ayuda && <small className="suave chico">{ayuda}</small>}
      </div>
    </label>
  );
}

export function MensajeError({ mensaje }: { mensaje: string | null }) {
  return mensaje ? <div className="alerta peligro">{mensaje}</div> : null;
}

export function Encabezado({ titulo, children }: { titulo: string; children?: ReactNode }) {
  return (
    <div className="fila separada encabezado">
      <h1>{titulo}</h1>
      <div className="fila">{children}</div>
    </div>
  );
}

export function fechaHora(f: string | null): string {
  return f ? new Date(f).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

export const numero = (n: number | null | undefined) => (n ?? 0).toLocaleString('es-AR');
