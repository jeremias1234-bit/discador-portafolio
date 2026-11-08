// Normalización de teléfonos argentinos al formato que se guarda y se marca por los Dinstar:
// 10 dígitos nacionales, sin 0 ni 15 (ej. 2617256360).
//   "+54 9 261 725-6360" | "0261 15 725-6360" | "261 15 7256360" | "2617256360" -> "2617256360"

const LARGO_NACIONAL = 10;

export function normalizarTelefono(entrada: string | null | undefined): string | null {
  if (!entrada) return null;
  let d = entrada.replace(/\D/g, '');

  if (d.startsWith('00')) d = d.slice(2);
  // Código de país, y el 9 de celulares en formato internacional
  if (d.startsWith('54') && d.length >= 12) {
    d = d.slice(2);
    if (d.startsWith('9') && d.length === 11) d = d.slice(1);
  }
  if (d.startsWith('0')) d = d.slice(1);

  // Celular con 15 después de la característica (de 2, 3 o 4 dígitos)
  if (d.length === LARGO_NACIONAL + 2) {
    const posiciones = d.startsWith('11') ? [2, 3, 4] : [3, 4, 2];
    const k = posiciones.find((p) => d.slice(p, p + 2) === '15');
    if (k !== undefined) d = d.slice(0, k) + d.slice(k + 2);
  }

  return d.length === LARGO_NACIONAL ? d : null;
}

/**
 * DNI de lo que escribió un cliente: 7 u 8 dígitos (con puntos o espacios), o el del medio de un
 * CUIT/CUIL. "30.123.456" | "DNI 30 123 456" | "20-30123456-7" -> "30123456"; sin DNI -> null.
 */
export function extraerDni(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const cuit = /(?<!\d)(20|23|24|27|30|33|34)[-.\s]?(\d{1,2}[.\s]?\d{3}[.\s]?\d{3})[-.\s]?\d(?!\d)/.exec(texto);
  if (cuit) {
    const dni = cuit[2]!.replace(/\D/g, '');
    if (dni.length >= 7) return dni;
  }
  const m = /(?<!\d)(\d{1,2}[.\s]?\d{3}[.\s]?\d{3})(?!\d)/.exec(texto);
  const dni = m?.[1]!.replace(/\D/g, '');
  return dni && dni.length >= 7 && dni.length <= 8 ? dni : null;
}
