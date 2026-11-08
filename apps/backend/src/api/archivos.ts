// Lectura de archivos subidos (multipart) y decodificación de texto.
import type { FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { errorHttp } from './errores.js';

/**
 * Recorre el multipart: junta los campos de texto y entrega el archivo (como stream) a `alArchivo`.
 * Los campos tienen que venir ANTES que el archivo en el formulario.
 */
export async function leerMultipart<T>(
  req: FastifyRequest,
  alArchivo: (archivo: MultipartFile, campos: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (!req.isMultipart()) throw errorHttp(400, 'Se esperaba un formulario multipart con un archivo');
  const campos: Record<string, string> = {};
  for await (const parte of req.parts()) {
    if (parte.type === 'field') {
      campos[parte.fieldname] = String(parte.value);
    } else {
      return alArchivo(parte, campos);
    }
  }
  throw errorHttp(400, 'Falta el archivo');
}

/** UTF-8 si es válido; si no, Windows-1252 (los CSV que exporta Excel en español). Sin BOM. */
export function decodificarTexto(buffer: Buffer): string {
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    texto = new TextDecoder('windows-1252').decode(buffer);
  }
  return texto.replace(/^﻿/, '');
}

/** Separador más probable según la primera línea. */
export function detectarSeparador(texto: string): string {
  const primera = texto.slice(0, texto.search(/\r?\n|$/));
  const candidatos = [';', ',', '\t', '|'];
  return candidatos.reduce((mejor, c) => (primera.split(c).length > primera.split(mejor).length ? c : mejor), ',');
}
