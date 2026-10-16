// Lectura de los documentos PDF de una convocatoria: bases, convocatoria, anexos.
//
// Solo se hace BAJO DEMANDA (herramienta ayuda_texto) y el texto extraído se guarda en la
// caché: cada documento se descarga y procesa una sola vez.
//
// No usa ningún LLM: localiza los apartados (cuantía, plazo, beneficiarios…) por sus títulos y
// devuelve el texto LITERAL con su número de página, para que se pueda comprobar en el original.

import { DIA, guardar, leer } from "./cache.js";
import { norm } from "./texto.js";

export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_PAGINAS = 200;

// --- Elección del documento -----------------------------------------------------------------

export interface DocumentoRef {
  id: string;
  nombre: string;
}

const IDIOMAS_OTROS = /\b(euskera|euskara|catala|catalan|valencia|valenciano|galego|gallego|basque|eus|cat|val|gal)\b/;
const NO_CONVOCATORIA =
  /\b(anexo|anexos|modelo|solicitud|instancia|declaracion|formulario|justificacion|certificado|ficha|memoria|cuenta|autorizacion|aceptacion|renuncia|alegaciones|cuestionario)\b/;

/** Puntúa un documento por su nombre: cuanto mayor, más probable que sea el texto de la convocatoria. */
export function puntuarDocumento(nombre: string): number {
  const n = norm(nombre);
  let p = 0;
  if (/\b(convocatoria|bases|resolucion|acuerdo|decreto|orden)\b/.test(n)) p += 4;
  // El texto íntegro de las bases gana a «el documento de la convocatoria», que a veces es solo
  // el acuerdo de aprobación (una página) y no las bases.
  if (/\b(texto integro|texto completo|bases reguladoras|bases de la convocatoria|bases especificas)\b/.test(n)) p += 8;
  if (/\b(castellano|espanol|spanish|cast)\b/.test(n)) p += 3;
  if (/\b(texto en castellano|documento de la convocatoria)\b/.test(n)) p += 3;
  if (/\bextracto|anuncio\b/.test(n)) p += 1; // el extracto es un resumen: sirve si no hay otra cosa
  if (NO_CONVOCATORIA.test(n)) p -= 5;
  if (IDIOMAS_OTROS.test(n) && !/\b(castellano|espanol)\b/.test(n)) p -= 4;
  if (/\.(docx?|odt|xlsx?|zip)\s*$/i.test(nombre)) p -= 8;
  return p;
}

/** Documentos ordenados de más a menos probable como texto principal. */
export function ordenarDocumentos<T extends DocumentoRef>(docs: T[]): T[] {
  return [...docs]
    .map((d, i) => ({ d, i, p: puntuarDocumento(d.nombre) }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x) => x.d);
}

// --- Extracción de texto --------------------------------------------------------------------

export interface TextoDocumento {
  id: string;
  paginas: string[]; // texto limpio de cada página
  total_paginas: number;
  truncado: boolean; // solo se leyeron MAX_PAGINAS
  escaneado: boolean; // sin capa de texto: no se puede leer sin OCR
  bytes: number;
}

const normLinea = (l: string) => norm(l).replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/**
 * Quita lo que se repite en la mayoría de páginas (cabeceras, pies, «Página 3 de 31», códigos
 * de validación) y une las palabras partidas por guion al final de línea.
 */
export function limpiarPaginas(brutas: string[]): string[] {
  const paginas = brutas.map((t) =>
    t
      .replace(/\u0000/g, "")
      .replace(/\r/g, "")
      // Palabra partida por guion al final de línea: en minúsculas («subven-⏎ción») y en
      // mayúsculas («COM-⏎PETITIVA»). No se une «socio-⏎Económico» (minúscula + mayúscula).
      .replace(
        /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])-\n([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/g,
        (todo, a: string, b: string) =>
          b === b.toLowerCase() || a === a.toUpperCase() ? a + b : todo,
      )
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim()),
  );
  const umbral = Math.max(3, Math.ceil(paginas.length * 0.4));
  const veces = new Map<string, number>();
  if (paginas.length >= 4) {
    for (const lineas of paginas) {
      for (const l of new Set(lineas.map(normLinea))) {
        if (l.length >= 3 && l.length <= 200) veces.set(l, (veces.get(l) ?? 0) + 1);
      }
    }
  }
  return paginas.map((lineas) =>
    lineas
      .filter((l) => l && !(paginas.length >= 4 && (veces.get(normLinea(l)) ?? 0) >= umbral))
      .join("\n"),
  );
}

export async function extraerPdf(datos: Uint8Array, id: string): Promise<TextoDocumento> {
  const cabecera = new TextDecoder().decode(datos.slice(0, 5));
  if (!cabecera.startsWith("%PDF")) {
    throw new Error("El documento no es un PDF (puede ser Word, Excel u otro formato): ábrelo desde su enlace.");
  }
  // Se carga solo al leer un documento: el arranque del servidor no paga ni tiempo ni memoria.
  const { extractText, getDocumentProxy } = await import("unpdf");
  // verbosity 0: pdfjs escribe avisos en stdout, que en un servidor MCP es el canal del protocolo.
  const pdf = await getDocumentProxy(datos, { verbosity: 0 } as never);
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const leidas = (text as string[]).slice(0, MAX_PAGINAS);
  const paginas = limpiarPaginas(leidas);
  const chars = paginas.reduce((a, p) => a + p.length, 0);
  return {
    id,
    paginas,
    total_paginas: totalPages,
    truncado: totalPages > MAX_PAGINAS,
    // Menos de ~80 caracteres por página de media: es una imagen escaneada, sin texto.
    escaneado: chars / Math.max(1, leidas.length) < 80,
    bytes: datos.length,
  };
}

// --- Caché ----------------------------------------------------------------------------------

/** Un documento publicado no cambia: su texto se guarda un mes. */
const VIGENCIA_TEXTO = 30 * DIA;

export const leerTextoGuardado = (id: string) => leer<TextoDocumento>(`pdf:${id}`);

export function guardarTexto(t: TextoDocumento) {
  guardar(`pdf:${t.id}`, t, VIGENCIA_TEXTO);
}

// --- Localización de apartados --------------------------------------------------------------

export const TEMAS = {
  cuantia: "Cuantía, importe y financiación",
  plazo: "Plazo de solicitud",
  beneficiarios: "Beneficiarios",
  requisitos: "Requisitos y condiciones",
  documentacion: "Documentación a presentar",
  gastos: "Gastos o actuaciones subvencionables",
  criterios: "Criterios de valoración",
  presentacion: "Lugar y forma de presentación",
  justificacion: "Justificación y pago",
  objeto: "Objeto y finalidad",
} as const;
export type Tema = keyof typeof TEMAS;

/** Se aplica sobre el texto normalizado (sin tildes, en minúsculas) de un título de apartado. */
const PATRON_TEMA: Record<Tema, RegExp> = {
  cuantia:
    /\b(cuantias?|importes?|dotacion(es)?|credito(s)? presupuestarios?|financiacion|quantia|import maxim|presupuesto)\b/,
  plazo: /\b(plazos?|termini|prazo|presentacion de (las )?(solicitudes|instancias))\b/,
  beneficiarios: /\b(beneficiari\w+|destinatari\w+|quienes pueden|personas? (solicitantes|interesadas))\b/,
  requisitos: /\b(requisitos?|condiciones (de|para)|obligaciones de (los|las) beneficiari\w+)\b/,
  documentacion:
    /\b(documentacion|documentos? (a presentar|necesarios?|que (deber|se))|se acompanar|acompanar a la solicitud)\b/,
  gastos: /\b(gastos? (subvencionables?|elegibles?)|conceptos? subvencionables?|actuaciones? subvencionables?|actividades? subvencionables?|despeses subvencionables)\b/,
  criterios: /\b(criterios? de (valoracion|concesion|adjudicacion|baremacion|seleccion|reparto)|baremo de (valoracion|puntuacion))\b/,
  presentacion:
    /\b(lugar (y|de) (forma|presentacion)|forma de presentacion|lugar de presentacion|medios? de presentacion|sede electronica|registro electronico|presentacion telematica)\b/,
  justificacion: /\b(justificacion|abono|pago de la (subvencion|ayuda))\b/,
  objeto: /\b(objeto|finalidad|objetivo)s?\b/,
};

const ORDINALES =
  "primer[oa]|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa]|s[eé]ptim[oa]|octav[oa]|noven[oa]|" +
  "d[eé]cim[oa]|und[eé]cim[oa]|duod[eé]cim[oa]|d[eé]cimo\\s?(?:tercer|cuart|quint|sext|s[eé]ptim|octav|noven)[oa]?|vig[eé]sim[oa]";
const RE_ARTICULO = new RegExp(
  `^(art[ií]culo|art\\.|base|cl[aá]usula|apartado|punto|cap[ií]tulo|t[ií]tulo|secci[oó]n|disposici[oó]n|anexo|(${ORDINALES}))\\s*[\\dIVXLC\\w]*\\s*[.:\\-–—]`,
  "i",
);
const RE_NUMERADO = /^(\d{1,2}(?:\.\d{1,2}){0,3})\s*[.)\-–—]?\s+\S/;
const RE_LETRA = /^[a-z]\)\s/i;

interface Linea {
  pag: number;
  texto: string;
}

/** Nivel de un posible título de apartado (1 = principal), o 0 si la línea no lo parece. */
export function nivelTitulo(l: string): number {
  if (l.length > 150 || l.length < 3) return 0;
  if (RE_ARTICULO.test(l)) return 1;
  if (new RegExp(`^(${ORDINALES})\\s*[.:\\-–—]`, "i").test(l)) return 1;
  const num = l.match(RE_NUMERADO);
  if (num) {
    // «3.» o «3» → nivel 1; «3.1» → nivel 2. Descarta importes y fechas («2026 », «1.500 euros»).
    const partes = num[1].split(".");
    if (partes.some((p) => p.length > 2) || Number(partes[0]) > 60) return 0;
    if (/^\d{1,2}\s+(de|euros?|€|%)/i.test(l) || /^\d{1,2}[.,]\d{3}/.test(l)) return 0;
    return partes.length;
  }
  if (RE_LETRA.test(l)) return 3;
  // Línea en mayúsculas (título de sección): sin minúsculas y con al menos 5 letras.
  const letras = l.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, "");
  if (letras.length >= 5 && letras === letras.toUpperCase() && l.length <= 100) return 1;
  return 0;
}

function aLineas(paginas: string[]): Linea[] {
  return paginas.flatMap((t, i) => t.split("\n").filter(Boolean).map((texto) => ({ pag: i + 1, texto })));
}

/** Une las líneas partidas por el ancho de página en párrafos. */
function aTexto(lineas: Linea[]): string {
  let out = "";
  for (const { texto } of lineas) {
    if (!out) out = texto;
    else if (/[.:;]$/.test(out) || nivelTitulo(texto) > 0 || /^([-•·–]|\d+[.)]|[a-z]\))\s/i.test(texto)) out += "\n" + texto;
    else out += " " + texto;
  }
  return out;
}

export interface Pasaje {
  tema: Tema;
  /** apartado: bajo un título que corresponde al tema · mencion: texto que lo menciona, sin apartado propio. */
  tipo: "apartado" | "mencion";
  titulo: string;
  paginas: [number, number];
  texto: string;
  recortado: boolean;
}

/** Dedupe de pasajes que se solapan (un apartado dentro de otro ya devuelto). */
function sinSolape<T extends { ini: number; fin: number }>(ps: T[]): T[] {
  const usados: { ini: number; fin: number }[] = [];
  return ps.filter((p) => {
    if (usados.some((u) => p.ini < u.fin && p.fin > u.ini)) return false;
    usados.push(p);
    return true;
  });
}

const RE_EURO = /(?<![\d.,])(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?\s?(?:€|euros?\b|eur\b)/i;

/**
 * Título de un apartado, sin numeración: «Artículo 5. Cuantía de la subvención.» → «Cuantía de la
 * subvención»; «5. Reformulación: cuando el importe…» → «Reformulación». La palabra clave de un
 * tema debe estar en el título; si solo aparece en el cuerpo, es una mención, no el apartado.
 */
export function tituloDe(linea: string): string {
  const sinNumero = linea
    .replace(/^(art[ií]culo|art\.|base|cl[aá]usula|apartado|punto|cap[ií]tulo|t[ií]tulo|secci[oó]n|anexo)\s*[\dIVXLC\w]*\s*[.:\-–—)]*\s*/i, "")
    .replace(new RegExp(`^(${ORDINALES})\\s*[.:\\-–—]+\\s*`, "i"), "")
    .replace(/^\d{1,2}(?:\.\d{1,2}){0,3}\s*[.)\-–—]?\s*/, "")
    .replace(/^[a-z]\)\s*/i, "");
  // Corta en el primer punto o dos puntos, pero no en «15.000» ni en «3.1»: solo si va seguido de espacio.
  return sinNumero.split(/[.:](?=\s|$)|\s[-–—]\s/)[0].trim();
}

/** Número de un título numerado de primer nivel («6. Plazo…» → 6), o null. */
function numeroDe(linea: string): number | null {
  const m = linea.match(RE_NUMERADO);
  if (!m || m[1].includes(".")) return null;
  const n = Number(m[1]);
  return n <= 60 ? n : null;
}

/**
 * Palabras que, en el título de un apartado, indican que NO es el tema aunque lo mencione:
 * protección de datos (destinatarios de los datos) o justificación posterior a la concesión.
 */
const EXCLUIR_EN_TITULO: Partial<Record<Tema, RegExp>> = {
  beneficiarios: /\b(datos|cesion|tratamiento|comunicaci)/,
  documentacion: /\b(justificativ|justificacion|datos personales)/,
  requisitos: /\b(datos|tecnicos? del)/,
  plazo: /\b(justificacion|resolucion|recurso|ejecucion|realizacion|vigencia|duracion|prescripcion|subsanacion)\b/,
};

/** ¿Parece un título de apartado y no una frase? Los títulos son sintagmas cortos, no oraciones. */
export function pareceTitulo(titulo: string): boolean {
  if (titulo.length > 85) return false;
  if (titulo.split(/\s+/).length > 11) return false;
  if (/^[a-záéíóúñ]/.test(titulo)) return false; // las frases cortadas empiezan en minúscula
  // Una línea que acaba en artículo o preposición es el primer trozo de una frase partida por el
  // ancho de página, no un título («…entre los beneficiarios de la»).
  if (/\b(de|del|la|el|los|las|que|y|o|e|en|a|al|con|por|para|un|una|se|su|sus|lo|como|sobre|entre|sin)$/i.test(titulo)) return false;
  if (/^(en el caso|en caso|cuando|si\b|siempre que|una vez|todo|toda|los|las|se )/i.test(titulo)) return false;
  // Verbos conjugados típicos de una oración («deberán», «será», «se presentará»…).
  return !/\b(deber[aá]n?|podr[aá]n?|ser[aá]n?|ser[aá]|est[aá]n?|tendr[aá]n?|propondr[aá]|estudiar[aá]|verificar[aá]|formular[aá]|se presentar|se valorar|se concede|se abonar|ha de|han de|debe|puede|podr[ií]a|correspond)/i.test(norm(titulo));
}

/** Puntuación de un pasaje candidato: cuanto más, mejor respuesta al tema. */
function puntuarPasaje(tema: Tema, nivel: number, texto: string): number {
  let p = 10 - nivel * 2; // los apartados principales valen más que los subapartados
  const largo = texto.length;
  if (largo < 60) p -= 8; // solo el título: es un índice o una enumeración, no el apartado
  else if (largo < 150) p -= 3;
  else if (largo > 300) p += 2;
  const n = norm(texto);
  if (tema === "cuantia" && RE_EURO.test(texto)) p += 6;
  if (tema === "cuantia" && /\d\s?%/.test(texto)) p += 1;
  if (tema === "plazo" && /\b(dias?|mes(es)?|habiles|naturales|hasta|desde|fecha|\d{4})\b/.test(n)) p += 4;
  if (tema === "documentacion" && /\b(dni|nif|certificado|declaracion|copia|modelo|anexo)\b/.test(n)) p += 3;
  if (tema === "criterios" && /\b(puntos?|puntuacion|ponderacion|%)\b/.test(n)) p += 3;
  return p;
}

/**
 * Localiza los apartados de un tema por su título. Si ningún título coincide, busca ventanas
 * de texto alrededor de las palabras del tema (para la cuantía, exigiendo un importe en euros).
 */
export function buscarTema(paginas: string[], tema: Tema, maxChars: number, maxPasajes = 3): Pasaje[] {
  const lineas = aLineas(paginas);
  const patron = PATRON_TEMA[tema];
  const candidatos: { ini: number; fin: number; puntos: number; tipo: "apartado" | "mencion" }[] = [];

  // Zona de anexos (formularios de solicitud, declaraciones): ahí no está el contenido de las
  // bases. Solo se aplica si el primer «ANEXO» no está al principio (si no, todo el archivo lo es).
  let inicioAnexo = lineas.findIndex((l, i) => i > lineas.length * 0.2 && /^anexo\s+([ivxl]+|\d+|[a-z])\b/i.test(l.texto));
  if (inicioAnexo < 0) inicioAnexo = Infinity;

  const excluir = EXCLUIR_EN_TITULO[tema];
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i].texto;
    const titulo = tituloDe(linea);
    if (!titulo || !patron.test(norm(titulo)) || !pareceTitulo(titulo)) continue;
    if (excluir?.test(norm(titulo))) continue;
    let nivel = nivelTitulo(linea);
    if (!nivel) {
      // «Cuantía.- La cuantía total será…»: título corto seguido del texto en la misma línea.
      const sigue = linea.indexOf(titulo) + titulo.length;
      if (titulo.length > 60 || !/^[.:]/.test(linea.slice(sigue, sigue + 1)) || !/^[A-ZÁÉÍÓÚÑ]/.test(titulo)) continue;
      nivel = 2;
    }
    // Hasta el siguiente título del mismo nivel o superior. Los subapartados numerados reinician
    // la cuenta («6. Plazo» → «1.», «2.»…), así que un título numerado cierra el apartado solo si
    // su número es mayor que el del apartado; y uno sin número («Artículo 6.») no se cierra con «1.».
    const num = numeroDe(linea);
    let fin = i + 1;
    while (fin < lineas.length) {
      const sig = lineas[fin].texto;
      const n = nivelTitulo(sig);
      if (n && n <= nivel) {
        const numSig = numeroDe(sig);
        const esSubapartado = numSig !== null && (num === null || numSig <= num);
        if (!esSubapartado) break;
      }
      fin++;
    }
    const texto = aTexto(lineas.slice(i, fin));
    if (texto.length < 60) continue; // solo el título (índice o enumeración), sin contenido
    const enAnexo = i >= inicioAnexo ? 6 : 0;
    candidatos.push({ ini: i, fin, puntos: puntuarPasaje(tema, nivel, texto) - enAnexo, tipo: "apartado" });
  }

  // Si no hay un apartado claro, para la cuantía y el plazo (que se reconocen por su contenido:
  // importes en euros, duraciones o fechas) se buscan menciones en el texto. Para el resto, solo
  // si no hay ningún apartado: una mención suelta de «requisitos» no responde a nada.
  const mejor = Math.max(-99, ...candidatos.map((c) => c.puntos));
  const porContenido = tema === "cuantia" || tema === "plazo";
  if ((porContenido && mejor < 6) || candidatos.length === 0) {
    for (let i = 0; i < lineas.length; i++) {
      const nl = norm(lineas[i].texto);
      if (!patron.test(nl) || excluir?.test(nl)) continue;
      // Empezar en el principio de la frase: retroceder mientras la línea anterior no termine en punto.
      let ini = i;
      while (ini > 0 && i - ini < 3 && !/[.:;]$/.test(lineas[ini - 1].texto) && !nivelTitulo(lineas[ini - 1].texto)) ini--;
      const fin = Math.min(lineas.length, i + 8);
      const bloque = aTexto(lineas.slice(ini, fin));
      if (tema === "cuantia" && !RE_EURO.test(bloque)) continue;
      if (tema === "plazo") {
        // Debe hablar del plazo para PRESENTAR solicitudes y dar una duración o una fecha.
        const habla = /\b(presentaci[oó]n|presentar|solicitudes?|instancias?)\b/i.test(lineas[i].texto + " " + (lineas[i + 1]?.texto ?? ""));
        const dato = /\b(\d+|[a-zñ]+)\s+(d[ií]as|meses|mes)\b|\bhasta el\b|\b\d{1,2} de [a-zñ]+ de \d{4}\b/i.test(bloque);
        if (!habla || !dato) continue;
      }
      candidatos.push({ ini, fin, puntos: puntuarPasaje(tema, 4, bloque) - 1, tipo: "mencion" });
    }
  }

  // Los mejores por puntuación, sin solaparse, y luego en el orden del documento.
  const elegidos = sinSolape([...candidatos].sort((a, b) => b.puntos - a.puntos || a.ini - b.ini))
    .slice(0, maxPasajes)
    .sort((a, b) => a.ini - b.ini);

  return elegidos.map(({ ini, fin, tipo }) => {
    const trozo = lineas.slice(ini, fin);
    let texto = aTexto(trozo);
    const recortado = texto.length > maxChars;
    if (recortado) texto = texto.slice(0, maxChars).replace(/\s+\S*$/, "") + " […]";
    return {
      tema,
      tipo,
      titulo: trozo[0].texto.slice(0, 120),
      paginas: [trozo[0].pag, trozo[trozo.length - 1].pag] as [number, number],
      texto,
      recortado,
    };
  });
}

/** Pasajes que contienen TODAS las palabras dadas (sin tildes, ni mayúsculas), con su página. */
export function buscarPalabras(paginas: string[], palabras: string[], contexto = 350, max = 6) {
  const buscadas = palabras.map((p) => norm(p)).filter(Boolean);
  const resultados: { pagina: number; texto: string }[] = [];
  for (let i = 0; i < paginas.length && resultados.length < max; i++) {
    const original = paginas[i].replace(/\n/g, " ");
    const n = norm(original);
    if (!buscadas.every((p) => n.includes(p))) continue;
    // La normalización quita tildes carácter a carácter, así que los índices coinciden.
    const pos = n.indexOf(buscadas[0]);
    const ini = Math.max(0, pos - contexto);
    const fin = Math.min(original.length, pos + buscadas[0].length + contexto);
    resultados.push({ pagina: i + 1, texto: (ini > 0 ? "… " : "") + original.slice(ini, fin).trim() + (fin < original.length ? " …" : "") });
  }
  return resultados;
}

export interface Importe {
  importe: string;
  pagina: number;
  contexto: string;
}

/** Cantidades en euros del documento, con la frase en la que aparecen (para entender a qué se refieren). */
export function importesEnTexto(paginas: string[], max = 12): Importe[] {
  const out: Importe[] = [];
  const vistos = new Set<string>();
  const re = /(?<![\d.,])(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?\s?(?:€|euros?\b|eur\b)/gi;
  for (let i = 0; i < paginas.length && out.length < max; i++) {
    const t = paginas[i].replace(/\n/g, " ");
    for (const m of t.matchAll(re)) {
      const ini = Math.max(0, (m.index ?? 0) - 90);
      const ctx = t.slice(ini, (m.index ?? 0) + m[0].length + 60).trim();
      const clave = m[0] + "|" + ctx.slice(0, 40);
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      out.push({ importe: m[0].trim(), pagina: i + 1, contexto: ctx });
      if (out.length >= max) break;
    }
  }
  return out;
}
