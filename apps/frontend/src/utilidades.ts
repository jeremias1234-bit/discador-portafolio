import { useEffect, useState } from 'react';

/** Hora actual que se actualiza sola (para cronómetros). */
export function useAhora(intervaloMs = 1000): number {
  const [ahora, setAhora] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);
  return ahora;
}

/** 75 -> "1:15"; 3700 -> "1:01:40" */
export function duracion(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function horaCorta(fecha: string | number | Date): string {
  return new Date(fecha).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

/** Etiqueta legible de una columna del CSV: "fecha_alta" -> "Fecha alta" */
export function etiqueta(clave: string): string {
  const t = clave.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
