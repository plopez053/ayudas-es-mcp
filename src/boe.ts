// Cliente mínimo de la API de datos abiertos del BOE.
// Docs: https://www.boe.es/datosabiertos/documentos/APIsumarioBOE.pdf

import { hoy } from "./fechas.js";
import { pedirConReintentos } from "./red.js";
import { contienePalabras, norm } from "./texto.js";

const API = "https://www.boe.es/datosabiertos/api/boe";

export interface Publicacion {
  id: string;
  titulo: string;
  seccion: string;
  seccion_codigo: string; // "1", "2A", "2B", "3", "4", "5A", "5B", "5C"
  departamento: string;
  epigrafe: string;
  fecha: string; // YYYY-MM-DD
  url_html: string;
  url_pdf: string;
}

/** La API devuelve un objeto cuando hay uno y un array cuando hay varios. */
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function toApiDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Fecha inválida "${iso}". Usa el formato YYYY-MM-DD.`);
  }
  return iso.replaceAll("-", "");
}

/** Hoy en España (el BOE se publica por días de calendario peninsulares). */
export const todayIso = hoy;

export const SECCIONES = {
  "1": "Disposiciones generales (leyes, reales decretos, órdenes)",
  "2A": "Nombramientos, situaciones e incidencias",
  "2B": "Oposiciones y concursos",
  "3": "Otras disposiciones (convenios, ayudas, resoluciones)",
  "4": "Administración de Justicia",
  "5A": "Anuncios de contratación del sector público (licitaciones)",
  "5B": "Otros anuncios oficiales",
  "5C": "Anuncios particulares",
} as const;
export type Seccion = keyof typeof SECCIONES;

// El sumario de un día ya publicado no cambia: se guarda en memoria.
const cacheSumarios = new Map<string, Promise<Publicacion[]>>();

/** Devuelve las publicaciones de un día. Vacío si ese día no hay BOE (p. ej. domingos). */
export function sumarioDia(iso: string): Promise<Publicacion[]> {
  toApiDate(iso); // valida antes de cachear
  const esPasado = iso < todayIso();
  const cached = esPasado ? cacheSumarios.get(iso) : undefined;
  if (cached) return cached;
  const p = cargarSumario(iso);
  if (esPasado) {
    cacheSumarios.set(iso, p);
    p.catch(() => cacheSumarios.delete(iso));
  }
  return p;
}

async function cargarSumario(iso: string): Promise<Publicacion[]> {
  const res = await pedirConReintentos(`${API}/sumario/${toApiDate(iso)}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`BOE respondió ${res.status} para ${iso}`);

  const json: any = await res.json();
  const out: Publicacion[] = [];

  for (const diario of asArray<any>(json?.data?.sumario?.diario)) {
    for (const sec of asArray<any>(diario.seccion)) {
      for (const dep of asArray<any>(sec.departamento)) {
        const push = (item: any, epigrafe: string) => {
          out.push({
            id: item.identificador,
            titulo: item.titulo,
            seccion: sec.nombre,
            seccion_codigo: sec.codigo,
            departamento: dep.nombre,
            epigrafe,
            fecha: iso,
            url_html: item.url_html,
            url_pdf: item.url_pdf?.texto,
          });
        };
        for (const item of asArray<any>(dep.item)) push(item, "");
        for (const ep of asArray<any>(dep.epigrafe)) {
          for (const item of asArray<any>(ep.item)) push(item, ep.nombre);
        }
      }
    }
  }
  return out;
}

/** Texto plano de una disposición a partir de su identificador (p. ej. BOE-A-2026-21317). */
export async function textoDocumento(id: string, maxChars: number): Promise<string> {
  if (!/^BOE-[A-Z]-\d{4}-\d+$/.test(id)) {
    throw new Error(`Identificador inválido "${id}". Ejemplo: BOE-A-2026-21317.`);
  }
  const res = await pedirConReintentos(`https://www.boe.es/diario_boe/xml.php?id=${id}`);
  if (!res.ok) throw new Error(`BOE respondió ${res.status} para ${id}`);
  const xml = await res.text();

  // El bloque <analisis> (metadatos, referencias, notas) también contiene <texto>;
  // el cuerpo de la disposición es el <texto> que va después.
  const tras = xml.includes("</analisis>") ? xml.split("</analisis>").pop()! : xml;
  const body = tras.match(/<texto>[\s\S]*<\/texto>/)?.[0] ?? tras;
  const titulo = xml.match(/<titulo>([\s\S]*?)<\/titulo>/)?.[1]?.trim();
  const text = body
    .replace(/<\/(p|li|h\d|tr|blockquote)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&nbsp;", " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const completo = titulo ? `${titulo}\n\n${text}` : text;
  return completo.length > maxChars
    ? completo.slice(0, maxChars) + `\n\n[... texto truncado a ${maxChars} caracteres]`
    : completo;
}

/** Lista los días entre dos fechas (ambas incluidas). */
export function rangoDias(desde: string, hasta: string, maxDias: number): string[] {
  const a = new Date(desde + "T00:00:00Z");
  const b = new Date(hasta + "T00:00:00Z");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) throw new Error("Fechas inválidas.");
  if (b < a) throw new Error("'hasta' no puede ser anterior a 'desde'.");
  const dias: string[] = [];
  for (let d = a; d <= b; d = new Date(d.getTime() + 86_400_000)) {
    dias.push(d.toISOString().slice(0, 10));
    if (dias.length > maxDias) {
      throw new Error(`El rango máximo es de ${maxDias} días.`);
    }
  }
  return dias;
}

/** Ejecuta tareas con concurrencia limitada para no saturar la API del BOE. */
export async function conLimite<T, R>(
  items: T[],
  limite: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Todas las palabras deben aparecer en título, departamento o epígrafe (reglas de texto.ts:
 * sin tildes, límite de palabra, singular/plural y prefijo con "*").
 * Con soloTitulo se ignora el departamento, para que "comercio" no coincida con
 * todo lo que publica el Ministerio de Economía, Comercio y Empresa.
 */
export function coincide(p: Publicacion, palabras: string[], soloTitulo = false): boolean {
  const texto = norm(soloTitulo ? p.titulo : `${p.titulo} ${p.departamento} ${p.epigrafe}`);
  return contienePalabras(texto, palabras);
}
