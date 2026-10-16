// Texto de los documentos de una convocatoria, bajo demanda y con caché.

import { BdnsNoDisponible, descargarDocumento } from "./bdns.js";
import { detalleDirecto, type DetalleCompleto } from "./directo.js";
import {
  extraerPdf,
  guardarTexto,
  leerTextoGuardado,
  MAX_BYTES,
  ordenarDocumentos,
  type TextoDocumento,
} from "./documentos.js";

export interface DocumentoConId {
  id: string;
  nombre: string;
  url: string;
}

export interface TextoDeAyuda {
  detalle: DetalleCompleto;
  documentos: DocumentoConId[]; // todos, ordenados de más a menos probable como texto principal
  elegido: DocumentoConId;
  texto: TextoDocumento;
  desdeCache: boolean;
  /** Documentos más probables que no se han podido leer, y por qué. */
  descartados: { documento: DocumentoConId; motivo: string }[];
}

/** Procesos en curso: dos preguntas por el mismo documento no lo descargan dos veces. */
const enCurso = new Map<string, Promise<TextoDocumento>>();

async function textoDe(id: string): Promise<{ texto: TextoDocumento; desdeCache: boolean }> {
  const guardado = leerTextoGuardado(id);
  if (guardado) return { texto: guardado, desdeCache: true };
  let p = enCurso.get(id);
  if (!p) {
    p = (async () => {
      const datos = await descargarDocumento(id, MAX_BYTES);
      const t = await extraerPdf(datos, id);
      guardarTexto(t);
      return t;
    })().finally(() => enCurso.delete(id));
    enCurso.set(id, p);
  }
  return { texto: await p, desdeCache: false };
}

/**
 * Texto de un documento de la convocatoria. Sin `documentoId`, elige el que más probablemente
 * sea el texto de la convocatoria o de las bases (no un anexo ni un formulario).
 */
export async function textoDeAyuda(codigo: string, documentoId?: string): Promise<TextoDeAyuda> {
  const detalle = await detalleDirecto(codigo);
  const documentos: DocumentoConId[] = ordenarDocumentos(
    detalle.documentos
      .map((d) => ({ id: d.url.match(/idDocumento=(\d+)/)?.[1] ?? "", nombre: d.nombre, url: d.url }))
      .filter((d) => d.id),
  );
  if (documentos.length === 0) {
    throw new Error(
      "Esta convocatoria no tiene documentos adjuntos en la BDNS. El texto oficial suele estar en " +
        "el boletín donde se publicó el extracto (ver ayuda_detalle).",
    );
  }
  if (documentoId) {
    const elegido = documentos.find((d) => d.id === documentoId);
    if (!elegido) {
      throw new Error(
        `El documento ${documentoId} no es de esta convocatoria. Disponibles: ` +
          documentos.map((d) => `${d.id} (${d.nombre})`).join("; "),
      );
    }
    return { detalle, documentos, elegido, ...(await textoDe(elegido.id)), descartados: [] };
  }
  // Sin documento indicado: si el más probable no se puede leer (es un Word, pesa demasiado,
  // está roto), se prueba con el siguiente en vez de fallar. Un bloqueo de la BDNS sí corta.
  const descartados: { documento: DocumentoConId; motivo: string }[] = [];
  for (const d of documentos.slice(0, 3)) {
    try {
      return { detalle, documentos, elegido: d, ...(await textoDe(d.id)), descartados };
    } catch (e) {
      if (e instanceof BdnsNoDisponible) throw e;
      descartados.push({ documento: d, motivo: (e as Error).message });
    }
  }
  throw new Error(
    "No se ha podido leer ningún documento de la convocatoria: " +
      descartados.map((x) => `«${x.documento.nombre}»: ${x.motivo}`).join(" · "),
  );
}
