// Cliente de la API del backend. La sesión viaja en la cookie 'sesion' (mismo origen).

export class ErrorApi extends Error {
  constructor(
    public estado: number,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

/** Se llama cuando el backend responde 401: la sesión venció o se cerró en otro lado. */
let alPerderSesion: (() => void) | null = null;
export function avisarSesionPerdida(fn: () => void): void {
  alPerderSesion = fn;
}

async function pedir<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  const opciones: RequestInit = { method: metodo, credentials: 'same-origin', headers: {} };
  if (cuerpo instanceof FormData) {
    opciones.body = cuerpo;
  } else if (cuerpo !== undefined) {
    opciones.body = JSON.stringify(cuerpo);
    (opciones.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  let respuesta: Response;
  try {
    respuesta = await fetch(ruta, opciones);
  } catch {
    throw new ErrorApi(0, 'No hay conexión con el servidor');
  }

  const tipo = respuesta.headers.get('content-type') ?? '';
  const datos: unknown = tipo.includes('application/json') ? await respuesta.json().catch(() => null) : null;
  if (!respuesta.ok) {
    if (respuesta.status === 401 && ruta !== '/api/auth/login') alPerderSesion?.();
    const mensaje = (datos as { message?: string } | null)?.message ?? `Error ${respuesta.status}`;
    throw new ErrorApi(respuesta.status, mensaje);
  }
  return datos as T;
}

export const api = {
  get: <T>(ruta: string) => pedir<T>('GET', ruta),
  post: <T = { ok: boolean }>(ruta: string, cuerpo: unknown = {}) => pedir<T>('POST', ruta, cuerpo),
  put: <T = { ok: boolean }>(ruta: string, cuerpo: unknown) => pedir<T>('PUT', ruta, cuerpo),
  patch: <T = { ok: boolean }>(ruta: string, cuerpo: unknown) => pedir<T>('PATCH', ruta, cuerpo),
  borrar: <T = { ok: boolean }>(ruta: string) => pedir<T>('DELETE', ruta),
};

export function mensajeDeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
