// Plazo de solicitud de una convocatoria a partir de los textos de la BDNS.
//
// La BDNS solo trae fechas de inicio/fin en parte de las convocatorias. En el resto el plazo
// viene en texto: una fecha escrita ("hasta el 30 de noviembre de 2026"), un plazo relativo
// a la publicación del extracto ("10 días hábiles desde el día siguiente") o la indicación de
// que no hay solicitud (concesión directa o nominativa). Aquí se interpreta de forma
// determinista y, si no se puede con seguridad, se deja como "consultar".
//
// Cómputo según la Ley 39/2015, art. 30: los días son hábiles salvo que se diga otra cosa
// (se excluyen sábados, domingos y festivos); los plazos en meses acaban el mismo día del mes
// de vencimiento; si el último día es inhábil, se pasa al siguiente hábil.

import { hoy as hoyEspana } from "./fechas.js";
import { pedirConReintentos } from "./red.js";
import { norm } from "./texto.js";

export type TipoPlazo =
  | "fechas" // fechas explícitas de la BDNS o escritas en el texto
  | "calculado" // relativo a la publicación del extracto, calculado con el calendario
  | "pendiente_publicacion" // relativo a una publicación que aún no consta
  | "sin_plazo" // no hay solicitud: concesión directa, nominativa...
  | "desconocido";

export interface Plazo {
  tipo: TipoPlazo;
  inicio: string | null;
  fin: string | null;
  explicacion: string;
}

/** Sube cuando cambian las reglas: los plazos guardados se recalculan sin volver a la BDNS. */
export const VERSION_PLAZOS = 3;

export interface EntradaPlazo {
  /** tipoConvocatoria de la BDNS, p. ej. "Concesión directa - instrumental". */
  tipo_convocatoria: string;
  fecha_inicio: string | null; // de la BDNS
  fecha_fin: string | null;
  texto_inicio: string | null;
  texto_fin: string | null;
  fecha_registro: string;
  publicacion: { fecha: string; diario: string } | null; // primera publicación del extracto
}

/** Festivos (YYYY-MM-DD) que aplican a la convocatoria. */
export type Festivos = (anio: number) => Promise<Set<string>>;

// --- Fechas ---------------------------------------------------------------------------------

const MESES: Record<string, number> = {};
[
  // castellano, gallego y catalán
  ["enero", "xaneiro", "gener"],
  ["febrero", "febreiro", "febrer"],
  ["marzo", "marzo", "marc"],
  ["abril", "abril", "abril"],
  ["mayo", "maio", "maig"],
  ["junio", "xuno", "juny"],
  ["julio", "xullo", "juliol"],
  ["agosto", "agosto", "agost"],
  ["septiembre", "setembro", "setembre", "setiembre"],
  ["octubre", "outubro", "octubre"],
  ["noviembre", "novembro", "novembre"],
  ["diciembre", "decembro", "desembre"],
].forEach((nombres, i) => nombres.forEach((n) => (MESES[n] = i + 1)));

const pad = (n: number) => String(n).padStart(2, "0");
const isoDe = (a: number, m: number, d: number) => `${a}-${pad(m)}-${pad(d)}`;
const valida = (a: number, m: number, d: number) => {
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
};
const sumarDias = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** Fechas escritas en un texto ("30 de noviembre de 2026", "1/3/27", "31 de decembro"). */
export function fechasEnTexto(texto: string, anioReferencia: string): string[] {
  const t = norm(texto);
  const out: string[] = [];
  const refAnio = Number(anioReferencia.slice(0, 4));

  const nombres = Object.keys(MESES).join("|");
  const reNombre = new RegExp(
    `\\b(\\d{1,2})\\s*(?:de\\s+|d'|d\\s)?(${nombres})\\b(?:\\s*(?:de|del)?\\s*(\\d{4}))?`,
    "g",
  );
  for (const m of t.matchAll(reNombre)) {
    const d = Number(m[1]);
    const mes = MESES[m[2]];
    let a = m[3] ? Number(m[3]) : refAnio;
    if (!m[3] && isoDe(a, mes, d) < anioReferencia) a++; // "31 de diciembre" sin año
    if (valida(a, mes, d)) out.push(isoDe(a, mes, d));
  }
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (valida(a, Number(m[2]), Number(m[1]))) out.push(isoDe(a, Number(m[2]), Number(m[1])));
  }
  return out;
}

// --- Duraciones -----------------------------------------------------------------------------

const NUMEROS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40,
  "cuarenta y cinco": 45, cincuenta: 50, sesenta: 60, noventa: 90,
};

export interface Duracion {
  n: number;
  unidad: "habiles" | "naturales" | "meses";
}

/** "Diez (10) días hábiles", "15 días naturales", "un mes", "veinte días" (hábiles por ley). */
export function duracionEnTexto(texto: string): Duracion | null {
  const t = norm(texto);
  const palabras = Object.keys(NUMEROS).sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(
    `\\b(\\d{1,3}|${palabras})\\s*(?:\\((\\d{1,3})\\)\\s*)?(dias?|mes(?:es)?)\\s*(habiles|naturales|laborables)?`,
    "g",
  );
  const encontradas = [...t.matchAll(re)];
  if (encontradas.length !== 1) return null; // ninguna o varias: ambiguo
  const m = encontradas[0];
  const n = m[2] ? Number(m[2]) : /^\d/.test(m[1]) ? Number(m[1]) : NUMEROS[m[1]];
  if (!n) return null;
  if (m[3].startsWith("mes")) return { n, unidad: "meses" };
  return { n, unidad: m[4] === "naturales" ? "naturales" : "habiles" };
}

// --- Calendario -----------------------------------------------------------------------------

async function esHabil(iso: string, festivos: Festivos): Promise<boolean> {
  const dia = new Date(iso + "T00:00:00Z").getUTCDay();
  if (dia === 0 || dia === 6) return false;
  return !(await festivos(Number(iso.slice(0, 4)))).has(iso);
}

async function siguienteHabil(iso: string, festivos: Festivos): Promise<string> {
  let d = iso;
  while (!(await esHabil(d, festivos))) d = sumarDias(d, 1);
  return d;
}

/** Último día del plazo contado desde el día siguiente a la publicación. */
export async function vencimiento(publicacion: string, dur: Duracion, festivos: Festivos): Promise<string> {
  if (dur.unidad === "habiles") {
    let d = publicacion;
    for (let contados = 0; contados < dur.n; ) {
      d = sumarDias(d, 1);
      if (await esHabil(d, festivos)) contados++;
    }
    return d;
  }
  if (dur.unidad === "naturales") return siguienteHabil(sumarDias(publicacion, dur.n), festivos);
  // Meses: el mismo día de la publicación en el mes de vencimiento (o el último del mes).
  const [a, m, d] = publicacion.split("-").map(Number);
  const total = m - 1 + dur.n;
  const anio = a + Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return siguienteHabil(isoDe(anio, mes, Math.min(d, ultimo)), festivos);
}

// --- Interpretación -------------------------------------------------------------------------

const SIN_PLAZO =
  /\b(sin plazo|no procede|no aplica|no tiene|no hay plazo|no existe plazo|concesion directa|nominativ|no se requiere solicitud|de oficio|sense termini|no hi ha termini|sen prazo|non procede)\b/;
/** Inicio distinto del día siguiente a la publicación: no se calcula para no equivocarse. */
const INICIO_RARO = /\b(quinto|tercer|segundo|transcurrid|a partir del \d|habiles desde el dia siguiente al de la finalizacion)\b/;

export async function interpretarPlazo(e: EntradaPlazo, festivos: Festivos): Promise<Plazo> {
  const ti = e.texto_inicio?.trim() ?? "";
  const tf = e.texto_fin?.trim() ?? "";
  const ambos = norm(`${ti} ${tf}`);

  // 1. Convocatoria "instrumental": la BDNS la crea solo para registrar una concesión directa
  //    a un beneficiario concreto. Sus fechas, si las tiene, son las de ejecución, no de solicitud.
  if (/instrumental/i.test(e.tipo_convocatoria)) {
    return {
      tipo: "sin_plazo",
      inicio: null,
      fin: null,
      explicacion:
        "Registro de una concesión directa a un beneficiario concreto (convocatoria instrumental " +
        "en la BDNS): no admite solicitudes.",
    };
  }

  // 2. Fechas explícitas de la BDNS.
  if (e.fecha_fin) {
    return { tipo: "fechas", inicio: e.fecha_inicio, fin: e.fecha_fin, explicacion: "Fechas indicadas en la BDNS." };
  }

  // 3. Sin solicitud.
  if (SIN_PLAZO.test(ambos) && !duracionEnTexto(ambos) && fechasEnTexto(tf, e.fecha_registro).length === 0) {
    return {
      tipo: "sin_plazo",
      inicio: null,
      fin: null,
      explicacion: "La convocatoria no tiene plazo de solicitud (concesión directa, nominativa o similar).",
    };
  }

  // 4. Fecha de fin escrita en el texto. Con varias (varios periodos), se toma la última.
  const finesTexto = fechasEnTexto(tf, e.fecha_registro);
  if (finesTexto.length) {
    const fin = finesTexto.sort().at(-1)!;
    const inicio = e.fecha_inicio ?? fechasEnTexto(ti, e.fecha_registro).sort()[0] ?? null;
    return {
      tipo: "fechas",
      inicio,
      fin,
      explicacion:
        finesTexto.length > 1
          ? `Varios periodos de solicitud; el último termina el ${fin} (según el texto de la convocatoria).`
          : `Fecha de fin tomada del texto de la convocatoria: «${tf}».`,
    };
  }

  // 5. Plazo relativo a la publicación del extracto.
  const dur = duracionEnTexto(tf) ?? duracionEnTexto(ti);
  if (dur && !INICIO_RARO.test(ambos)) {
    const etiqueta = `${dur.n} ${dur.unidad === "meses" ? (dur.n === 1 ? "mes" : "meses") : `días ${dur.unidad}`}`;
    if (!e.publicacion) {
      return {
        tipo: "pendiente_publicacion",
        inicio: null,
        fin: null,
        explicacion: `Plazo de ${etiqueta} desde la publicación del extracto, que aún no consta en la BDNS.`,
      };
    }
    const inicio = await siguienteHabil(sumarDias(e.publicacion.fecha, 1), festivos);
    const fin = await vencimiento(e.publicacion.fecha, dur, festivos);
    return {
      tipo: "calculado",
      inicio,
      fin,
      explicacion:
        `Calculado: ${etiqueta} desde el día siguiente a la publicación en ${e.publicacion.diario} ` +
        `(${e.publicacion.fecha}), ` +
        (dur.unidad === "habiles"
          ? "descontando sábados, domingos y festivos nacionales y autonómicos"
          : "pasando al siguiente día hábil si el último es sábado, domingo o festivo nacional o autonómico") +
        ` (no se tienen en cuenta los festivos locales). Confírmalo en el extracto.`,
    };
  }

  return { tipo: "desconocido", inicio: e.fecha_inicio, fin: null, explicacion: "No se ha podido interpretar el plazo." };
}

// --- Estado ---------------------------------------------------------------------------------

export type Estado =
  | "abierta"
  | "proximamente"
  | "cerrada"
  | "pendiente_publicacion"
  | "sin_plazo"
  | "consultar";

/** El campo "abierto" de la API viene siempre a false: el estado se deduce del plazo. */
export function estadoDe(
  p: Pick<Plazo, "tipo" | "inicio" | "fin">,
  hoy = hoyEspana(),
): Estado {
  if (p.tipo === "sin_plazo") return "sin_plazo";
  if (p.tipo === "pendiente_publicacion") return "pendiente_publicacion";
  if (p.fin && p.fin < hoy) return "cerrada";
  if (p.inicio && p.inicio > hoy) return "proximamente";
  if (p.fin) return "abierta";
  return "consultar";
}

/** Estados en los que todavía se puede (o se podrá) solicitar. */
export const SOLICITABLE: Estado[] = ["abierta", "proximamente", "pendiente_publicacion", "consultar"];

// --- Festivos -------------------------------------------------------------------------------

/** Código ISO 3166-2 de cada comunidad, como lo usa Nager.Date. */
export const ISO_COMUNIDAD: Record<string, string> = {
  andalucia: "ES-AN", aragon: "ES-AR", asturias: "ES-AS", baleares: "ES-IB", canarias: "ES-CN",
  cantabria: "ES-CB", "castilla-la-mancha": "ES-CM", "castilla-y-leon": "ES-CL", cataluna: "ES-CT",
  ceuta: "ES-CE", "comunidad-valenciana": "ES-VC", extremadura: "ES-EX", galicia: "ES-GA",
  "la-rioja": "ES-RI", madrid: "ES-MD", melilla: "ES-ML", murcia: "ES-MC", navarra: "ES-NC",
  "pais-vasco": "ES-PV",
};

type FestivoNager = { date: string; global: boolean; counties: string[] | null };
const cacheAnio = new Map<number, Promise<FestivoNager[]>>();

/** Festivos nacionales de España y, si se indica, los de una comunidad (Nager.Date, sin clave). */
export function festivosDe(comunidad: string | null): Festivos {
  const codigo = comunidad ? ISO_COMUNIDAD[comunidad] : undefined;
  return async (anio) => {
    let p = cacheAnio.get(anio);
    if (!p) {
      p = pedirConReintentos(`https://date.nager.at/api/v3/PublicHolidays/${anio}/ES`).then((r) => {
        if (!r.ok) throw new Error(`Calendario de festivos no disponible (${r.status})`);
        return r.json() as Promise<FestivoNager[]>;
      });
      p.catch(() => cacheAnio.delete(anio));
      cacheAnio.set(anio, p);
    }
    const lista = await p;
    return new Set(
      lista.filter((f) => f.global || (codigo && f.counties?.includes(codigo))).map((f) => f.date),
    );
  };
}
