// El softphone vive a nivel de la aplicación: la línea sigue abierta al cambiar de pantalla
// (el supervisor escucha desde el monitor con la misma línea).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useYo } from '../sesion';
import { Softphone, urlWssPorDefecto, type EstadoSoftphone } from './softphone';

interface ContextoTelefono {
  /** null si el usuario no tiene interno o usa un teléfono externo. */
  softphone: Softphone | null;
  estado: EstadoSoftphone | null;
}

const Contexto = createContext<ContextoTelefono>({ softphone: null, estado: null });

export function ProveedorTelefono({ children }: { children: ReactNode }) {
  const yo = useYo();
  const [softphone, setSoftphone] = useState<Softphone | null>(null);
  const [estado, setEstado] = useState<EstadoSoftphone | null>(null);
  const usaNavegador = yo.tipo_telefono === 'navegador' && !!yo.interno_sip && !!yo.clave_sip;

  useEffect(() => {
    if (!usaNavegador) return;
    const s = new Softphone();
    const desuscribir = s.suscribir(setEstado);
    s.iniciar({ interno: yo.interno_sip!, clave: yo.clave_sip!, urlWss: urlWssPorDefecto() });
    setSoftphone(s);
    // Al cerrar la pestaña se corta la línea en el momento (si la PC se cuelga, lo detecta
    // Asterisk por falta de audio: rtp_timeout en pjsip.conf)
    const alCerrar = () => s.destruir();
    window.addEventListener('pagehide', alCerrar);
    return () => {
      window.removeEventListener('pagehide', alCerrar);
      desuscribir();
      s.destruir();
      setSoftphone(null);
      setEstado(null);
    };
  }, [usaNavegador, yo.interno_sip, yo.clave_sip]);

  // Cerrar la pestaña con la línea abierta corta al cliente: se pide confirmación
  useEffect(() => {
    if (estado?.linea !== 'abierta') return;
    const avisar = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, [estado?.linea]);

  return <Contexto.Provider value={{ softphone, estado }}>{children}</Contexto.Provider>;
}

export function useTelefono(): ContextoTelefono {
  return useContext(Contexto);
}
