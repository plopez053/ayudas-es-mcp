// Convocatorias recurrentes y calendario previsto.
//
// Muchas ayudas se convocan cada año por las mismas fechas (las del comercio local de un
// ayuntamiento, las becas de una diputación...). Agrupando las convocatorias de un mismo
// órgano con el mismo título sin años ni ediciones se obtiene una "serie"; si se ha convocado
// en varios años, su fecha típica permite prever cuándo saldrá la de este año.
//
// El histórico (títulos y fechas desde 2021, unas 40 peticiones) se descarga como mucho una vez
// por semana y en segundo plano; de él solo se guardan en la caché las series calculadas.
//
// Es una previsión estadística sobre el histórico de la BDNS, no un anuncio oficial.

import { ADMINISTRACIONES, paginaListado, TAM_PAGINA, type FilaListado } from "./bdns.js";
import { conLimite } from "./boe.js";
import { DIA, guardar, leer, recordar } from "./cache.js";
import { codigosCon, type Filtros } from "./directo.js";
import { hoy as hoyEspana } from "./fechas.js";
import { contienePalabras, esDirectaProbable, norm, palabrasDe } from "./texto.js";

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

/** Primer año del histórico (completo: empieza el 1 de enero). */
export const HISTORICO_DESDE = "2021-01-01";
const PRIMER_ANIO = Number(HISTORICO_DESDE.slice(0, 4));

type Fila = Pick<FilaListado, "codigo" | "titulo" | "organo" | "departamento" | "administracion" | "fecha_registro">;

/** Convocatorias agrupadas por órgano + título de serie. */
function agrupar(filas: Fila[]): Map<string, Fila[]> {
  const grupos = new Map<string, Fila[]>();
  for (const f of filas) {
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

export type Confianza = "alta" | "media" | "baja";

/**
 * Confianza de una serie con sus años anteriores a `hastaAnio` (día del año de cada uno):
 * alta con 4+ años y poca variación, media con variación moderada, baja con el resto. Baja un
 * nivel si el año pasado se alejó mucho de su fecha típica (la mediana no lo ve: con 3 años,
 * uno movido dos meses deja la variación en pocos días), y como mucho es media si dejó de
 * convocarse algún año.
 */
export function confianzaDe(dias: Map<number, number>, tipico: number, dispersion: number, hastaAnio: number): Confianza {
  const anios = [...dias.keys()].filter((a) => a < hastaAnio);
  let nivel = anios.length >= 4 && dispersion <= 15 ? 2 : dispersion <= 30 ? 1 : 0;
  const huecos = hastaAnio - Math.min(...anios) - anios.length;
  if (huecos > 0) nivel = Math.min(nivel, 1);
  const ultimo = dias.get(hastaAnio - 1);
  if (ultimo !== undefined && distanciaCircular(ultimo, tipico) > Math.max(15, 2 * dispersion)) nivel = Math.max(0, nivel - 1);
  return (["baja", "media", "alta"] as const)[nivel];
}

/**
 * Evaluación retrospectiva: prevé el año `objetivo` usando solo los anteriores y lo compara
 * con lo que realmente se registró ese año.
 */
function evaluarPrevision(grupos: Map<string, Fila[]>, objetivo: number) {
  let series = 0; // recurrentes antes del año objetivo y activas el año anterior
  let salieron = 0; // de ellas, convocadas en el año objetivo
  const errores: number[] = [];
  const porConfianza: Record<string, number[]> = { alta: [], media: [], baja: [] };
  for (const filas of grupos.values()) {
    const porAnio = primeraPorAnio(filas);
    const e = estadistica(porAnio, PRIMER_ANIO, objetivo);
    if (!e || !porAnio.has(objetivo - 1)) continue;
    series++;
    const real = porAnio.get(objetivo);
    if (!real) continue;
    salieron++;
    const err = distanciaCircular(diaDelAnio(real.fecha_registro), e.tipico);
    errores.push(err);
    const dias = new Map([...porAnio].map(([a, f]) => [a, diaDelAnio(f.fecha_registro)]));
    porConfianza[confianzaDe(dias, e.tipico, e.dispersion, objetivo)].push(err);
  }
  const pct = (xs: number[], dias: number) =>
    xs.length ? Math.round((100 * xs.filter((x) => x <= dias).length) / xs.length) : 0;
  return {
    anio: objetivo,
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
    ) as Record<"alta" | "media" | "baja", { n: number; error_mediano: number | null; pct_a_15_dias: number }>,
  };
}

export type Evaluacion = ReturnType<typeof evaluarPrevision>;

export interface SerieFila {
  titulo: string; // el de la convocatoria más reciente
  organo: string;
  departamento: string;
  administracion: string;
  /** Primera convocatoria de cada año. */
  anios: Record<string, { codigo: string; fecha: string }>;
  dia_tipico: number; // día del año (0-365)
  dispersion: number; // desviación absoluta mediana, en días
  ultima_codigo: string;
  ultima_fecha: string;
  /** El órgano registra varias convocatorias con este título cada año: la fecha es la de la primera. */
  varias_al_anio: boolean;
  /** Todas las convocatorias de la serie (para reconocer una desde ayuda_detalle). */
  codigos: string[];
}

export interface Calendario {
  calculado: string;
  series: SerieFila[];
  evaluacion: Evaluacion | null;
}

/**
 * Series recurrentes (convocadas en al menos MIN_ANIOS años completos distintos) a partir de
 * las convocatorias del histórico. Función pura: las pruebas la llaman con filas inventadas.
 */
export function calcularCalendario(filas: Fila[], hoy = hoyEspana()): Calendario {
  const anioActual = Number(hoy.slice(0, 4));
  const grupos = agrupar(filas);
  const series: SerieFila[] = [];
  for (const g of grupos.values()) {
    const porAnio = primeraPorAnio(g);
    // Solo cuentan los años completos anteriores al actual para la estadística.
    const e = estadistica(porAnio, PRIMER_ANIO, anioActual);
    if (!e) continue;
    const ultima = g.reduce((a, b) => (b.fecha_registro > a.fecha_registro ? b : a));
    const porAnioN = new Map<string, number>();
    for (const f of g) porAnioN.set(f.fecha_registro.slice(0, 4), (porAnioN.get(f.fecha_registro.slice(0, 4)) ?? 0) + 1);
    series.push({
      titulo: ultima.titulo,
      organo: ultima.organo,
      departamento: ultima.departamento,
      administracion: ultima.administracion,
      anios: Object.fromEntries(
        [...porAnio.entries()].sort(([a], [b]) => a - b).map(([a, f]) => [a, { codigo: f.codigo, fecha: f.fecha_registro }]),
      ),
      dia_tipico: e.tipico,
      dispersion: e.dispersion,
      ultima_codigo: ultima.codigo,
      ultima_fecha: ultima.fecha_registro,
      // ¿Se registran varias con este título cada año? Entonces la serie mezcla ayudas distintas.
      varias_al_anio: mediana([...porAnioN.values()]) > 1,
      codigos: g.map((f) => f.codigo),
    });
  }
  return {
    calculado: new Date().toISOString(),
    series,
    // Fiabilidad medida: prever el año pasado con los anteriores y comparar con lo ocurrido.
    evaluacion: anioActual - 1 - PRIMER_ANIO >= MIN_ANIOS ? evaluarPrevision(grupos, anioActual - 1) : null,
  };
}

// --- Descarga y caché -----------------------------------------------------------------------

const CLAVE = "calendario";
const CLAVE_EN_CURSO = "calendario:en_curso";
/** Una semana: las series cambian poco, y así el histórico se descarga como mucho una vez por semana. */
const VIGENCIA = 7 * DIA;

/**
 * Peticiones del histórico en vuelo a la vez. El limitador de bdns.ts sigue lanzando como mucho
 * una por segundo, pero una página de 10.000 filas tarda varios segundos en llegar: de una en
 * una, el histórico tardaba unos 3 minutos. Con 4 a la vez la BDNS se ralentizaba hasta agotar
 * el tiempo máximo, y las preguntas que llegaban mientras tanto lo notaban.
 */
const EN_VUELO = 3;

/** Histórico desde HISTORICO_DESDE, año a año (cada año son unas 7 páginas de 10.000). */
async function descargarHistorico(log: (m: string) => void): Promise<Fila[]> {
  const hoy = hoyEspana();
  const anioActual = Number(hoy.slice(0, 4));
  const anios: [string, string][] = [];
  for (let a = PRIMER_ANIO; a <= anioActual; a++) anios.push([`${a}-01-01`, a === anioActual ? hoy : `${a}-12-31`]);

  // La primera página de cada año dice cuántas tiene; después, el resto de páginas.
  const primeras = await conLimite(anios, EN_VUELO, ([d, h]) => paginaListado({}, d, h, 0, TAM_PAGINA));
  log(`calendario: primeras páginas descargadas (${primeras.reduce((n, p) => n + p.total, 0)} convocatorias en total)`);
  const resto = anios.flatMap(([d, h], i) =>
    Array.from({ length: Math.ceil(primeras[i].total / TAM_PAGINA) - 1 }, (_, k) => [d, h, k + 1] as const),
  );
  const paginas = await conLimite(resto, EN_VUELO, ([d, h, p]) => paginaListado({}, d, h, p, TAM_PAGINA));

  // Solo los campos que hacen falta: el histórico completo son unas 380.000 filas. Sin
  // duplicados: si se registra una convocatoria durante la descarga, las páginas se desplazan.
  const vistas = new Set<string>();
  const filas: Fila[] = [];
  for (const f of [...primeras, ...paginas].flatMap((p) => p.filas)) {
    if (vistas.has(f.codigo)) continue;
    vistas.add(f.codigo);
    filas.push({
      codigo: f.codigo,
      titulo: f.titulo,
      organo: f.organo,
      departamento: f.departamento,
      administracion: f.administracion,
      fecha_registro: f.fecha_registro,
    });
  }
  log(`calendario: histórico descargado (${filas.length} convocatorias, ${primeras.length + paginas.length} páginas)`);
  return filas;
}

/** El calendario si ya está calculado (de esta sesión o de una anterior). */
export const calendario = () => leer<Calendario>(CLAVE);

/**
 * Calcula el calendario si no está en la caché. Se lanza en segundo plano al arrancar: tarda
 * un par de minutos y no debe bloquear ninguna pregunta. Si otra instancia del servidor ya lo
 * está calculando, no se duplica la descarga.
 */
export async function prepararCalendario(log: (m: string) => void = () => {}): Promise<Calendario | undefined> {
  const listo = calendario();
  if (listo) return listo;
  if (leer(CLAVE_EN_CURSO)) return undefined;
  guardar(CLAVE_EN_CURSO, true, 15 * 60_000);
  try {
    return await recordar(CLAVE, VIGENCIA, async () => {
      const t0 = Date.now();
      const c = calcularCalendario(await descargarHistorico(log));
      log(`calendario: ${c.series.length} series recurrentes en ${Math.round((Date.now() - t0) / 1000)} s`);
      return c;
    });
  } finally {
    guardar(CLAVE_EN_CURSO, false, 1);
  }
}

/** ¿Hay otra instancia (o esta) calculando el calendario? */
export const calendarioEnCurso = () => Boolean(leer(CLAVE_EN_CURSO));

let indice: { calculado: string; porCodigo: Map<string, SerieFila> } | undefined;

/** La serie a la que pertenece una convocatoria, si el calendario está calculado. */
export function serieDe(codigo: string): SerieFila | undefined {
  const c = calendario();
  if (!c) return undefined;
  if (indice?.calculado !== c.calculado) {
    const porCodigo = new Map<string, SerieFila>();
    for (const s of c.series) for (const cod of s.codigos) porCodigo.set(cod, s);
    indice = { calculado: c.calculado, porCodigo };
  }
  return indice.porCodigo.get(codigo);
}

/**
 * Series que cumplen los filtros. Las palabras y la administración se comprueban sobre la
 * propia serie; la comunidad, el beneficiario, la finalidad y el instrumento no constan en el
 * listado, así que se piden a la API los códigos que los cumplen desde el 1 de enero del año
 * pasado (lo que una serie activa tiene que haber registrado) y se cruzan.
 */
export async function seriesFiltradas(c: Calendario, f: Filtros): Promise<SerieFila[]> {
  let series = c.series;
  if (f.texto?.trim()) {
    const palabras = palabrasDe(f.texto);
    series = series.filter((s) => contienePalabras(norm(s.titulo), palabras));
  }
  if (f.administracion) series = series.filter((s) => s.administracion === ADMINISTRACIONES[f.administracion!]);
  if (f.comunidad || f.beneficiario || f.finalidad || f.instrumento) {
    const hoy = hoyEspana();
    const etiquetas: Filtros = {
      comunidad: f.comunidad,
      incluir_estatales: f.incluir_estatales,
      beneficiario: f.beneficiario,
      finalidad: f.finalidad,
      instrumento: f.instrumento,
    };
    const codigos = await codigosCon(etiquetas, `${Number(hoy.slice(0, 4)) - 1}-01-01`, hoy);
    series = series.filter((s) => codigos.has(s.ultima_codigo));
  }
  return series;
}

// --- Previsión ------------------------------------------------------------------------------

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
  confianza: Confianza;
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
  const dias = new Map(Object.entries(s.anios).map(([a, x]) => [Number(a), diaDelAnio(x.fecha)]));
  const confianza = confianzaDe(dias, s.dia_tipico, s.dispersion, anio);
  return { ...s, situacion, fecha_prevista, desde, hasta, confianza };
}
