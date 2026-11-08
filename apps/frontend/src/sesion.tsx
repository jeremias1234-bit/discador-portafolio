// Sesión del usuario conectado: quién es y qué puede hacer.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, avisarSesionPerdida, ErrorApi } from './api';
import type { Yo } from './tipos';

interface ContextoSesion {
  yo: Yo | null;
  cargando: boolean;
  entrar: (usuario: string, clave: string) => Promise<void>;
  salir: () => Promise<void>;
  /** true si tiene al menos uno de los permisos. */
  puede: (...permisos: string[]) => boolean;
}

const Contexto = createContext<ContextoSesion | null>(null);

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargando, setCargando] = useState(true);

  const cargarYo = useCallback(async () => {
    try {
      setYo(await api.get<Yo>('/api/auth/yo'));
    } catch (err) {
      if (!(err instanceof ErrorApi) || err.estado !== 401) throw err;
      setYo(null);
    }
  }, []);

  useEffect(() => {
    avisarSesionPerdida(() => setYo(null));
    cargarYo()
      .catch(() => setYo(null))
      .finally(() => setCargando(false));
  }, [cargarYo]);

  const entrar = useCallback(
    async (usuario: string, clave: string) => {
      await api.post('/api/auth/login', { usuario, clave });
      await cargarYo();
    },
    [cargarYo],
  );

  const salir = useCallback(async () => {
    await api.post('/api/auth/salir').catch(() => {});
    setYo(null);
  }, []);

  const puede = useCallback((...permisos: string[]) => !!yo && permisos.some((p) => yo.permisos.includes(p)), [yo]);

  return <Contexto.Provider value={{ yo, cargando, entrar, salir, puede }}>{children}</Contexto.Provider>;
}

export function useSesion(): ContextoSesion {
  const c = useContext(Contexto);
  if (!c) throw new Error('useSesion fuera de ProveedorSesion');
  return c;
}

/** Para pantallas que solo se muestran con sesión iniciada. */
export function useYo(): Yo {
  const { yo } = useSesion();
  if (!yo) throw new Error('useYo sin sesión');
  return yo;
}
