// Convocatorias recurrentes y calendario previsto.
//
// Muchas ayudas se convocan cada año por las mismas fechas (las del comercio local de un
// ayuntamiento, las becas de una diputación...). Agrupando las convocatorias de un mismo
// órgano con el mismo título sin años ni ediciones se obtiene una "serie"; si se ha convocado
// en varios años, su fecha típica permite prever cuándo saldrá la de este año.
//
// Es una previsión estadística sobre el histórico de la BDNS, no un anuncio oficial.

import { abrir, escribirMeta, leerMeta } from "./db.js";
import { hoy as hoyEspana } from "./fechas.js";
import { esDirectaProbable, norm } from "./texto.js";

const PALABRAS_DE_EDICION =
  /\b(convocatoria|convocatorias|ejercicio|anualidad|ano|anyo|curso|edicion|temporada|campana|deialdia|urtea|ikasturtea|exercici|exercicio|decreto de fecha|de fecha|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/g;

/** Título sin años, fechas, números, ediciones ni puntuación: "XIV Premios X 2026" ≈ "XV Premios X 2027". */
export function tituloDeSerie(titulo: string): string {
  return norm(titulo)
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b\d+(?:[ºª]|o|a|er|na|ta)?\b/g, " ")
    .replace(/\b[ivxlc]{1,6}\b/g, " ") // ordinales romanos
    .replace(PALABRAS_DE_EDICION, " ")
    .replace(/[^a-z0-9ñ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const diaDelAnio = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
};
const mediana = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Distancia en días entre dos días del año, dando la vuelta al año (28-dic ↔ 3-ene = 6). */
const distanciaCircular = (a: number, b: number) => {
  const d = Math.abs(a - b) % 365;
  return Math.min(d, 365 - d);
};

/** Día típico: el observado que minimiza la suma de distancias circulares a los demás. */
function diaTipico(dias: number[]): number {
  let mejor = dias[0];
  let coste = Infinity;
  for (const c of dias) {
    const s = dias.reduce((acc, d) => acc + distanciaCircular(c, d), 0);
    if (s < coste) [mejor, coste] = [c, s];
  }
  return mejor;
}

/** Años mínimos con convocatoria para considerar que una serie es recurrente. */
const MIN_ANIOS = 3;

type Fila = {
  codigo: string;
  titulo: string;
  organo: string;
  departamento: string;
  administracion: string;
  fecha_registro: string;
};

/** Convocatorias agrupadas por órgano + título de serie. */
function agrupar(): Map<string, Fila[]> {
  const grupos = new Map<string, Fila[]>();
  for (const f of abrir()
    .prepare("SELECT codigo, titulo, organo, departamento, administracion, fecha_registro FROM convocatorias")
    .all() as Fila[]) {
    // Sin solicitud posible (nominativas, directas, convenios): no tiene sentido prever cuándo "salen".
    if (esDirectaProbable(f.titulo)) continue;
    const t = tituloDeSerie(f.titulo);
    if (t.length < 8) continue; // títulos demasiado genéricos tras limpiar
    const clave = `${f.administracion}|${f.departamento}|${f.organo}|${t}`;
    let g = grupos.get(clave);
    if (!g) grupos.set(clave, (g = []));
    g.push(f);
  }
  return grupos;
}

/** Primera convocatoria de cada año. */
function primeraPorAnio(filas: Fila[]): Map<number, Fila> {
  const porAnio = new Map<number, Fila>();
  for (const f of filas) {
    const a = Number(f.fecha_registro.slice(0, 4));
    const prev = porAnio.get(a);
    if (!prev || f.fecha_registro < prev.fecha_registro) porAnio.set(a, f);
  }
  return porAnio;
}

/** Día típico y dispersión con los años completos en [desdeAnio, hastaAnio). Null si no es recurrente. */
function estadistica(porAnio: Map<number, Fila>, desdeAnio: number, hastaAnio: number) {
  const historicos = [...porAnio.entries()].filter(([a]) => a >= desdeAnio && a < hastaAnio);
  if (historicos.length < MIN_ANIOS) return null;
  const dias = historicos.map(([, f]) => diaDelAnio(f.fecha_registro));
  const tipico = diaTipico(dias);
  return {
    tipico,
    dispersion: mediana(dias.map((d) => distanciaCircular(d, tipico))),
    anios: historicos.length,
  };
}

function primerAnioCompleto(): number {
  const desde = leerMeta("ventana_desde") ?? "0000";
  return Number(desde.slice(0, 4)) + (desde.slice(5) === "01-01" ? 0 : 1);
}

/**
 * Evaluación retrospectiva: prevé el año `objetivo` usando solo los anteriores y lo compara
 * con lo que realmente se registró ese año.
 */
export function evaluarPrevision(objetivo: number) {
  const desde = primerAnioCompleto();
  let series = 0; // recurrentes antes del año objetivo y activas el año anterior
  let salieron = 0; // de ellas, convocadas en el año objetivo
  const errores: number[] = [];
  const porConfianza: Record<string, number[]> = { alta: [], media: [], baja: [] };
  for (const filas of agrupar().values()) {
    const porAnio = primeraPorAnio(filas);
    const e = estadistica(porAnio, desde, objetivo);
    if (!e || !porAnio.has(objetivo - 1)) continue;
    series++;
    const real = porAnio.get(objetivo);
    if (!real) continue;
    salieron++;
    const err = distanciaCircular(diaDelAnio(real.fecha_registro), e.tipico);
    errores.push(err);
    const conf = e.anios >= 4 && e.dispersion <= 15 ? "alta" : e.dispersion <= 30 ? "media" : "baja";
    porConfianza[conf].push(err);
  }
  const pct = (xs: number[], dias: number) =>
    xs.length ? Math.round((100 * xs.filter((x) => x <= dias).length) / xs.length) : 0;
  return {
    series,
    salieron,
    pct_salieron: Math.round((100 * salieron) / Math.max(1, series)),
    error_mediano_dias: errores.length ? mediana(errores) : null,
    pct_a_15_dias: pct(errores, 15),
    pct_a_30_dias: pct(errores, 30),
    por_confianza: Object.fromEntries(
      Object.entries(porConfianza).map(([k, xs]) => [
        k,
        { n: xs.length, error_mediano: xs.length ? mediana(xs) : null, pct_a_15_dias: pct(xs, 15) },
      ]),
    ),
  };
}

/**
 * Recalcula las series a partir de todas las convocatorias de la base. Solo se guardan las
 * recurrentes (convocadas en al menos MIN_ANIOS años completos distintos).
 */
export function recalcularSeries(): { series: number; convocatorias: number } {
  const db = abrir();
  db.exec(`
    CREATE TABLE IF NOT EXISTS series (
      id             INTEGER PRIMARY KEY,
      titulo         TEXT NOT NULL,   -- el de la convocatoria más reciente
      organo         TEXT NOT NULL,
      departamento   TEXT,
      administracion TEXT NOT NULL,
      anios          TEXT NOT NULL,   -- JSON {año: {codigo, fecha}} con la primera de cada año
      dia_tipico     INTEGER NOT NULL, -- día del año (0-365) mediano
      dispersion     INTEGER NOT NULL, -- desviación absoluta mediana, en días
      ultima_codigo  TEXT NOT NULL,
      ultima_fecha   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS series_miembros (
      codigo TEXT PRIMARY KEY,
      serie  INTEGER NOT NULL
    ) WITHOUT ROWID;
    DELETE FROM series; DELETE FROM series_miembros;
  `);
  if (!(db.prepare("PRAGMA table_info(series)").all() as { name: string }[]).some((c) => c.name === "varias_al_anio")) {
    db.exec("ALTER TABLE series ADD COLUMN varias_al_anio INTEGER NOT NULL DEFAULT 0");
  }

  const anioCompleto = primerAnioCompleto();
  const anioActual = new Date().getUTCFullYear();
  const grupos = agrupar();

  const insSerie = db.prepare(
    `INSERT INTO series (titulo, organo, departamento, administracion, anios, dia_tipico, dispersion,
                         ultima_codigo, ultima_fecha, varias_al_anio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insMiembro = db.prepare("INSERT OR REPLACE INTO series_miembros VALUES (?, ?)");
  let nSeries = 0;
  let nConv = 0;

  db.exec("BEGIN");
  try {
    for (const filas of grupos.values()) {
      const porAnio = primeraPorAnio(filas);
      // Solo cuentan los años completos anteriores al actual para la estadística.
      const e = estadistica(porAnio, anioCompleto, anioActual);
      if (!e) continue;
      const { tipico, dispersion } = e;
      const ultima = filas.reduce((a, b) => (b.fecha_registro > a.fecha_registro ? b : a));
      const anios = Object.fromEntries(
        [...porAnio.entries()].sort(([a], [b]) => a - b).map(([a, f]) => [a, { codigo: f.codigo, fecha: f.fecha_registro }]),
      );
      // ¿Se registran varias con este título cada año? Entonces la serie mezcla ayudas distintas.
      const porAnioN = new Map<string, number>();
      for (const f of filas) porAnioN.set(f.fecha_registro.slice(0, 4), (porAnioN.get(f.fecha_registro.slice(0, 4)) ?? 0) + 1);
      const varias = mediana([...porAnioN.values()]) > 1 ? 1 : 0;
      const r = insSerie.run(
        ultima.titulo, ultima.organo, ultima.departamento, ultima.administracion,
        JSON.stringify(anios), tipico, dispersion, ultima.codigo, ultima.fecha_registro, varias,
      );
      for (const f of filas) insMiembro.run(f.codigo, Number(r.lastInsertRowid));
      nSeries++;
      nConv += filas.length;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  escribirMeta("series_calculadas", new Date().toISOString());
  // Fiabilidad medida: prever el año pasado con los anteriores y comparar con lo ocurrido.
  if (anioActual - 1 - anioCompleto >= MIN_ANIOS) {
    escribirMeta("evaluacion_series", JSON.stringify({ anio: anioActual - 1, ...evaluarPrevision(anioActual - 1) }));
  }
  return { series: nSeries, convocatorias: nConv };
}

export type Evaluacion = ReturnType<typeof evaluarPrevision> & { anio: number };

export function evaluacionGuardada(): Evaluacion | undefined {
  const v = leerMeta("evaluacion_series");
  return v ? JSON.parse(v) : undefined;
}

// --- Consultas ------------------------------------------------------------------------------

export interface SerieFila {
  id: number;
  titulo: string;
  organo: string;
  departamento: string;
  administracion: string;
  anios: Record<string, { codigo: string; fecha: string }>;
  dia_tipico: number;
  dispersion: number;
  ultima_codigo: string;
  ultima_fecha: string;
  /** El órgano registra varias convocatorias con este título cada año: la fecha es la de la primera. */
  varias_al_anio: number;
}

/**
 * prevista: su fecha típica aún no ha llegado · en_margen: ya pasó, pero sigue dentro de su
 * variación habitual · retrasada: fuera de su margen y sin convocar · ya_convocada: este año
 * ya consta · inactiva: no se convocó el año pasado (puede haberse abandonado).
 */
export type Situacion = "prevista" | "en_margen" | "retrasada" | "ya_convocada" | "inactiva";

export interface Prevision extends SerieFila {
  situacion: Situacion;
  fecha_prevista: string; // día típico en el año en curso
  desde: string; // ventana probable
  hasta: string;
  confianza: "alta" | "media" | "baja";
}

const fechaDeDia = (anio: number, dia: number) =>
  new Date(Date.UTC(anio, 0, 1) + dia * 86_400_000).toISOString().slice(0, 10);

export function prever(s: SerieFila, hoy = hoyEspana()): Prevision {
  const anio = Number(hoy.slice(0, 4));
  const margen = Math.max(7, s.dispersion * 2);
  const fecha_prevista = fechaDeDia(anio, s.dia_tipico);
  const desde = fechaDeDia(anio, s.dia_tipico - margen);
  const hasta = fechaDeDia(anio, s.dia_tipico + margen);
  const situacion: Situacion = s.anios[String(anio)]
    ? "ya_convocada"
    : !s.anios[String(anio - 1)]
      ? "inactiva"
      : fecha_prevista >= hoy
        ? "prevista"
        : hasta >= hoy
          ? "en_margen"
          : "retrasada";
  const nAnios = Object.keys(s.anios).filter((a) => Number(a) < anio).length;
  const confianza = nAnios >= 4 && s.dispersion <= 15 ? "alta" : s.dispersion <= 30 ? "media" : "baja";
  return { ...s, situacion, fecha_prevista, desde, hasta, confianza };
}

const leerSerie = (r: any): SerieFila => ({ ...r, anios: JSON.parse(r.anios) });

export function serieDe(codigo: string): SerieFila | undefined {
  const r = abrir()
    .prepare("SELECT s.* FROM series s JOIN series_miembros m ON m.serie = s.id WHERE m.codigo = ?")
    .get(codigo);
  return r ? leerSerie(r) : undefined;
}

/**
 * Series cuya ventana prevista cae entre hoy y `dias` días, que aún no se han convocado este
 * año. Los filtros (SQL sobre la convocatoria más reciente de la serie) vienen de db.ts.
 */
export function seriesFiltradas(whereSql: string, params: (string | number)[]): SerieFila[] {
  return (
    abrir()
      .prepare(`SELECT s.* FROM series s JOIN convocatorias c ON c.codigo = s.ultima_codigo ${whereSql}`)
      .all(...params) as any[]
  ).map(leerSerie);
}

export const seriesListas = () => Boolean(leerMeta("series_calculadas"));
