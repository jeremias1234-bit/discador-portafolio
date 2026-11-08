// Exportación a CSV pensada para Excel en español: separador ';', BOM UTF-8 y coma decimal.
import type { FastifyReply } from 'fastify';

function celda(v: unknown): string {
  if (v === null || v === undefined) return '';
  let texto: string;
  if (v instanceof Date) texto = v.toISOString().replace('T', ' ').slice(0, 19);
  else if (typeof v === 'number') texto = String(v).replace('.', ',');
  else if (typeof v === 'object') texto = JSON.stringify(v);
  else texto = String(v);
  return /[;"\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

export function aCsv(filas: Record<string, unknown>[]): string {
  if (filas.length === 0) return '﻿';
  const columnas = Object.keys(filas[0]!);
  const lineas = [columnas.join(';'), ...filas.map((f) => columnas.map((c) => celda(f[c])).join(';'))];
  return '﻿' + lineas.join('\r\n') + '\r\n';
}

export function enviarCsv(reply: FastifyReply, nombre: string, filas: Record<string, unknown>[]): FastifyReply {
  return reply
    .type('text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${nombre}.csv"`)
    .send(aCsv(filas));
}
