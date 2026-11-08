// Hash de contraseñas con argon2id (parámetros por defecto de @node-rs/argon2, recomendados por OWASP).
import { hash, verify } from '@node-rs/argon2';

export function hashearClave(clave: string): Promise<string> {
  return hash(clave);
}

export async function verificarClave(hashGuardado: string, clave: string): Promise<boolean> {
  try {
    return await verify(hashGuardado, clave);
  } catch {
    return false; // hash con formato inválido
  }
}

// Cuando el usuario no existe igual se verifica contra este hash, para que el
// tiempo de respuesta no delate qué usuarios existen.
let hashFicticio: Promise<string> | undefined;

export async function simularVerificacion(clave: string): Promise<false> {
  hashFicticio ??= hash('clave-ficticia-para-igualar-tiempos');
  await verificarClave(await hashFicticio, clave);
  return false;
}
