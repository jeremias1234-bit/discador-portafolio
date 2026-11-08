// Ayudas para armar SQL.

/**
 * Arma "col1 = $2, col2 = $3" a partir de un objeto de cambios ya validado (las claves
 * vienen de un esquema zod estricto, nunca del usuario). Los placeholders arrancan en `desde`.
 */
export function armarUpdate(cambios: Record<string, unknown>, desde = 2): { asignaciones: string; valores: unknown[] } {
  const claves = Object.keys(cambios);
  return {
    asignaciones: claves.map((c, i) => `${c} = $${i + desde}`).join(', '),
    valores: claves.map((c) => cambios[c]),
  };
}

/** Escapa un valor para COPY ... FROM STDIN en formato texto. */
export function valorCopy(v: string | null | undefined): string {
  if (v === null || v === undefined) return '\\N';
  return v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
