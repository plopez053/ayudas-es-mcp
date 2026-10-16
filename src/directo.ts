// Consultas en directo a la API de la BDNS, sin copia local de la base de datos.
//
// La API filtra por fechas, comunidad, finalidad, beneficiario, instrumento, administración y
// palabras del título, y da el total exacto de coincidencias (totalElements) sin descargar las
// filas. Lo que no sabe hacer se completa aquí sobre las filas descargadas:
//   - las reglas de palabra de texto.ts: la API busca subcadenas ("tala" coincide con
//     "instalación"), así que se le envía la raíz de cada palabra y se filtra después;
//   - la estimación de concesión directa por el título.
// Las respuestas se guardan un tiempo en cache.ts, que no es una copia de la BDNS sino de lo ya
// preguntado.

import {
  ADMINISTRACIONES,
  BdnsNoDisponible,
  BENEFICIARIOS,
  cargarDetalle,
  COMUNIDADES,
  FINALIDADES,
  ID_ESPANA,
  idsRegion,
  INSTRUMENTOS,
  NACIONAL,
  paginaListado,
  TAM_PAGINA,
  type Administracion,
  type AyudaDetalle,
  type Beneficiario,
  type Comunidad,
  type FilaListado,
  type Finalidad,
  type Instrumento,
} from "./bdns.js";
import { DIA, HORA, leer, recordar } from "./cache.js";
import { haceDias, hoy as hoyEspana, sumarDias } from "./fechas.js";
import { estadoDe, festivosDe, interpretarPlazo, type Estado, type Plazo } from "./plazos.js";
import { baseDePalabra, contienePalabras, esDirectaProbable, norm, palabrasDe } from "./texto.js";

export interface Filtros {
  texto?: string;
  comunidad?: Comunidad;
  incluir_estatales?: boolean;
  beneficiario?: Beneficiario;
  finalidad?: Finalidad;
  instrumento?: Instrumento;
  administracion?: Administracion;
  desde?: string;
  hasta?: string;
  /** Excluir las concesiones directas que el título delata (precisión ~97 %, cobertura ~67 %). */
  excluir_directas?: boolean;
}

export const AGRUPACIONES = [
  "comunidad",
  "finalidad",
  "beneficiario",
  "instrumento",
  "administracion",
  "organo",
  "mes",
  "anio",
] as const;
export type Agrupacion = (typeof AGRUPACIONES)[number];

export interface DetalleCompleto extends AyudaDetalle {
  plazo_interpretado: Plazo;
}

/** Código de tipoAdministracion en la API para cada nivel. */
const TIPO_ADMINISTRACION: Record<keyof typeof ADMINISTRACIONES, string> = {
  estatal: "C",
  autonomica: "A",
  local: "L",
  otras: "O",
};

/**
 * Filtrar en local obliga a descargar todas las filas que la API devuelve para los filtros.
 * Por encima de esto (tres páginas, unos 10 s) se pide acotar en lugar de descargar el histórico.
 */
const MAX_FILAS_LOCAL = 3 * TAM_PAGINA;

/** Contador de peticiones a la BDNS (las servidas desde la caché no cuentan). */
export const coste = { peticiones: 0 };

/**
 * Página del listado, con caché. Un periodo que terminó hace más de una semana apenas cambia
 * (la BDNS admite registros con unos días de retraso): se guarda una semana. Si incluye días
 * recientes, una hora.
 */
function pagina(
  filtros: Record<string, string>,
  desde: string | undefined,
  hasta: string | undefined,
  page: number,
  pageSize: number,
) {
  const clave = `listado:${JSON.stringify([filtros, desde ?? "", hasta ?? "", page, pageSize])}`;
  const cerrado = hasta !== undefined && hasta < haceDias(7);
  return recordar(clave, cerrado ? 7 * DIA : HORA, () => {
    coste.peticiones++;
    return paginaListado(filtros, desde, hasta, page, pageSize);
  });
}

async function regionesDe(comunidades: (Comunidad | typeof NACIONAL)[]): Promise<string> {
  const ids: number[] = [];
  for (const c of comunidades) ids.push(...(c === NACIONAL ? [ID_ESPANA] : await idsRegion(c)));
  return ids.join(",");
}

/** Parámetros de la API para los filtros (sin las fechas, que van aparte). */
export async function parametros(f: Filtros): Promise<Record<string, string>> {
  const p: Record<string, string> = {};
  if (f.comunidad) {
    p.regiones = await regionesDe(f.incluir_estatales === false ? [f.comunidad] : [f.comunidad, NACIONAL]);
  }
  if (f.beneficiario) p.tiposBeneficiario = String(BENEFICIARIOS[f.beneficiario]);
  if (f.finalidad) p.finalidad = String(FINALIDADES[f.finalidad]);
  if (f.instrumento) p.instrumentos = String(INSTRUMENTOS[f.instrumento]);
  if (f.administracion) p.tipoAdministracion = TIPO_ADMINISTRACION[f.administracion];
  const raices = palabrasDe(f.texto ?? "").map(baseDePalabra).filter(Boolean);
  if (raices.length) {
    p.descripcion = raices.join(" ");
    p.descripcionTipoBusqueda = "1"; // todas las palabras
  }
  return p;
}

/** ¿Hay que descargar las filas y filtrarlas aquí, o basta el total de la API? */
const filtraEnLocal = (f: Filtros) => Boolean(f.texto?.trim() || f.excluir_directas);

export function cumple(fila: FilaListado, f: Filtros): boolean {
  if (f.excluir_directas && esDirectaProbable(fila.titulo)) return false;
  if (f.texto?.trim()) {
    return contienePalabras(norm(`${fila.titulo} ${fila.titulo_cooficial ?? ""}`), palabrasDe(f.texto));
  }
  return true;
}

/**
 * Coincidencias exactas de unos filtros: el total y las `n` más recientes.
 * Sin filtros locales, una sola petición; con ellos (o con `descargar`), todas las filas.
 */
async function coincidencias(
  f: Filtros,
  params: Record<string, string>,
  n: number,
  descargar = filtraEnLocal(f),
  maxFilas = MAX_FILAS_LOCAL,
): Promise<{ total: number; filas: FilaListado[]; todas?: FilaListado[] }> {
  if (!descargar) {
    const r = await pagina(params, f.desde, f.hasta, 0, Math.max(n, 1));
    return { total: r.total, filas: r.filas.slice(0, n) };
  }
  const primera = await pagina(params, f.desde, f.hasta, 0, TAM_PAGINA);
  if (primera.total > maxFilas) {
    throw new Error(
      `Estos filtros coinciden con ${primera.total} convocatorias antes de aplicar las palabras o ` +
        "la exclusión de concesiones directas, y habría que descargarlas todas. Acota con 'desde', " +
        "una comunidad o una finalidad.",
    );
  }
  // La primera página dice cuántas hay: el resto se pide a la vez.
  const resto = await Promise.all(
    Array.from({ length: Math.ceil(primera.total / TAM_PAGINA) - 1 }, (_, i) =>
      pagina(params, f.desde, f.hasta, i + 1, TAM_PAGINA),
    ),
  );
  const filas = [...primera.filas, ...resto.flatMap((r) => r.filas)];
  const todas = filas.filter((x) => cumple(x, f));
  return { total: todas.length, filas: todas.slice(0, n), todas };
}

/** Total exacto de coincidencias, sin muestra. */
export async function totalDirecto(f: Filtros): Promise<number> {
  return (await coincidencias(f, await parametros(f), 0)).total;
}

/**
 * Códigos de las convocatorias que cumplen los filtros en un periodo, para cruzarlos con las
 * series del calendario. Admite más filas que una búsqueda: se guarda en la caché.
 */
export async function codigosCon(f: Filtros, desde: string, hasta: string): Promise<Set<string>> {
  const r = await coincidencias({ ...f, desde, hasta }, await parametros(f), 0, true, 8 * TAM_PAGINA);
  return new Set(r.todas!.map((x) => x.codigo));
}

// --- Detalle --------------------------------------------------------------------------------

/** La comunidad si todas las regiones de la convocatoria son de una sola (para sus festivos). */
export function comunidadDeRegiones(regiones: string[]): Comunidad | null {
  const nuts = new Set(regiones.map((r) => r.match(/^(ES\d{2})/)?.[1] ?? "otra"));
  if (nuts.size !== 1) return null;
  const [codigo] = nuts;
  return (Object.keys(COMUNIDADES) as Comunidad[]).find((c) => COMUNIDADES[c] === codigo) ?? null;
}

async function plazoDe(d: AyudaDetalle): Promise<Plazo> {
  try {
    return await interpretarPlazo(
      {
        tipo_convocatoria: d.tipo,
        fecha_inicio: d.fecha_inicio,
        fecha_fin: d.fecha_fin,
        texto_inicio: d.texto_inicio,
        texto_fin: d.texto_fin,
        fecha_registro: d.fecha_registro,
        publicacion: d.publicaciones[0] ?? null,
      },
      festivosDe(comunidadDeRegiones(d.regiones)),
    );
  } catch (e) {
    return {
      tipo: "desconocido",
      inicio: d.fecha_inicio,
      fin: d.fecha_fin,
      explicacion: `No se pudo calcular el plazo (${(e as Error).message}).`,
    };
  }
}

/**
 * Vigencia de un detalle en la caché: un plazo provisional se concreta al publicarse el extracto
 * (un día); uno cerrado o sin solicitud ya no cambia (un mes); el resto, una semana.
 */
function vigenciaDetalle(d: DetalleCompleto): number {
  const p = d.plazo_interpretado;
  if (p.tipo === "pendiente_publicacion" || p.tipo === "desconocido") return DIA;
  const estado = estadoDe(p);
  return estado === "cerrada" || estado === "sin_plazo" ? 30 * DIA : 7 * DIA;
}

/** El detalle si ya está en la caché, sin pedirlo (para completar una respuesta sin coste). */
export const detalleGuardado = (codigo: string) => leer<DetalleCompleto>(`detalle:${codigo}`);

export function detalleDirecto(codigo: string): Promise<DetalleCompleto> {
  return recordar(`detalle:${codigo}`, vigenciaDetalle, async () => {
    coste.peticiones++;
    const d = await cargarDetalle(codigo);
    return { ...d, plazo_interpretado: await plazoDe(d) };
  });
}

// --- Búsqueda -------------------------------------------------------------------------------

export interface ResultadoBusqueda {
  total: number;
  /** De las revisadas (las que se han mostrado o descartado), cuántas estaban cerradas o sin solicitud. */
  revisadas: number;
  cerradas: number;
  sin_plazo: number;
  visibles: FilaListado[];
  detalles: Map<string, DetalleCompleto>;
  fallo: boolean;
}

/**
 * Total exacto y las más recientes con su detalle. Con `soloAbiertas`, se piden detalles hasta
 * reunir `limite` en las que aún se puede solicitar (o agotar el margen de candidatas).
 */
export async function buscarDirecto(f: Filtros, limite: number, soloAbiertas: boolean): Promise<ResultadoBusqueda> {
  const params = await parametros(f);
  const { total, filas } = await coincidencias(f, params, soloAbiertas ? limite * 3 : limite);
  const detalles = new Map<string, DetalleCompleto>();
  const visibles: FilaListado[] = [];
  const cuenta: Partial<Record<Estado, number>> = {};
  let revisadas = 0;
  let fallo = false;
  const pedir = (codigo: string) =>
    fallo
      ? undefined
      : detalleDirecto(codigo).catch((e) => {
          // Bloqueo o corte: el resto se muestra sin detalle. Otro error solo afecta a esa fila.
          if (e instanceof BdnsNoDisponible) fallo = true;
          return undefined;
        });
  // Se piden a la vez tantos detalles como huecos quedan; si alguno resulta cerrado, otra tanda.
  for (let i = 0; visibles.length < limite && i < filas.length; ) {
    const tanda = filas.slice(i, i + limite - visibles.length);
    i += tanda.length;
    const ds = await Promise.all(tanda.map((x) => pedir(x.codigo)));
    tanda.forEach((fila, k) => {
      const d = ds[k];
      if (d) {
        revisadas++;
        detalles.set(fila.codigo, d);
        const estado = estadoDe(d.plazo_interpretado);
        cuenta[estado] = (cuenta[estado] ?? 0) + 1;
        if (soloAbiertas && (estado === "cerrada" || estado === "sin_plazo")) return;
      }
      visibles.push(fila);
    });
  }
  return {
    total,
    revisadas,
    cerradas: cuenta.cerrada ?? 0,
    sin_plazo: cuenta.sin_plazo ?? 0,
    visibles,
    detalles,
    fallo,
  };
}

// --- Recuento -------------------------------------------------------------------------------

export interface GrupoDirecto {
  grupo: string;
  convocatorias: number;
  /** Solo cuando se han descargado las filas (con palabras o exclusión de directas). */
  titulos_distintos: number | null;
}

const titulosDistintos = (filas: FilaListado[]) =>
  new Set(filas.map((x) => `${norm(`${x.titulo} ${x.titulo_cooficial ?? ""}`)}|${x.organo}`)).size;

/** Meses (o años) entre dos fechas, recortados al rango: [nombre, desde, hasta]. */
function periodos(desde: string, hasta: string, por: "mes" | "anio"): [string, string, string][] {
  const out: [string, string, string][] = [];
  let ini = desde;
  while (ini <= hasta) {
    const [a, m] = ini.split("-").map(Number);
    const siguiente =
      por === "mes"
        ? `${m === 12 ? a + 1 : a}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`
        : `${a + 1}-01-01`;
    const fin = sumarDias(siguiente, -1) < hasta ? sumarDias(siguiente, -1) : hasta;
    out.push([por === "mes" ? ini.slice(0, 7) : ini.slice(0, 4), ini, fin]);
    ini = siguiente;
  }
  return out;
}

/** Una variante de los filtros por grupo: los filtros de la API cambian y, a veces, las fechas. */
type Variante = { grupo: string; params: Record<string, string>; desde?: string; hasta?: string };

async function variantes(f: Filtros, por: Agrupacion, base: Record<string, string>): Promise<Variante[]> {
  const conParam = (clave: string, valores: [string, string][]) =>
    valores.map(([grupo, v]) => ({ grupo, params: { ...base, [clave]: v } }));
  // Si se filtra por la misma dimensión que se agrupa, solo cuentan los valores filtrados.
  const solo = <T extends string>(todos: T[], filtrado?: T) => (filtrado ? [filtrado] : todos);
  switch (por) {
    case "comunidad": {
      const lista: (Comunidad | typeof NACIONAL)[] = f.comunidad
        ? f.incluir_estatales === false ? [f.comunidad] : [f.comunidad, NACIONAL]
        : [NACIONAL, ...(Object.keys(COMUNIDADES) as Comunidad[])];
      const out: Variante[] = [];
      for (const c of lista) out.push({ grupo: c, params: { ...base, regiones: await regionesDe([c]) } });
      return out;
    }
    case "finalidad":
      return conParam("finalidad", solo(Object.keys(FINALIDADES) as (keyof typeof FINALIDADES)[], f.finalidad)
        .map((k) => [k, String(FINALIDADES[k])]));
    case "beneficiario":
      return conParam("tiposBeneficiario", solo(Object.keys(BENEFICIARIOS) as (keyof typeof BENEFICIARIOS)[], f.beneficiario)
        .map((k) => [k, String(BENEFICIARIOS[k])]));
    case "instrumento":
      return conParam("instrumentos", solo(Object.keys(INSTRUMENTOS) as (keyof typeof INSTRUMENTOS)[], f.instrumento)
        .map((k) => [k, String(INSTRUMENTOS[k])]));
    case "administracion":
      return conParam("tipoAdministracion", solo(Object.keys(TIPO_ADMINISTRACION) as (keyof typeof TIPO_ADMINISTRACION)[], f.administracion)
        .map((k) => [ADMINISTRACIONES[k], TIPO_ADMINISTRACION[k]]));
    case "mes":
    case "anio": {
      const hasta = f.hasta ?? hoyEspana();
      // Sin 'desde': los últimos 12 meses o los últimos 5 años.
      const desde = f.desde ?? (por === "mes" ? `${sumarDias(hasta, -365).slice(0, 7)}-01` : `${Number(hasta.slice(0, 4)) - 4}-01-01`);
      return periodos(desde, hasta, por).map(([grupo, d, h]) => ({ grupo, params: base, desde: d, hasta: h }));
    }
    case "organo":
      return []; // se agrupan las filas descargadas
  }
}

/**
 * Recuento exacto agrupado. Sin palabras ni exclusión de directas, cada grupo es una petición
 * de total; con ellas, se descargan las filas de cada grupo y se cuentan aquí.
 */
export async function recuentoDirecto(
  f: Filtros,
  por: Agrupacion,
  limite: number,
): Promise<{ total: number; grupos: GrupoDirecto[] }> {
  const base = await parametros(f);
  // La API no filtra por órgano: para agrupar por él se descargan todas las filas.
  const { total, todas } = await coincidencias(f, base, 0, por === "organo" || filtraEnLocal(f));

  let grupos: GrupoDirecto[];
  if (por === "organo") {
    const porOrgano = new Map<string, FilaListado[]>();
    for (const x of todas!) {
      const g = `${x.organo} (${x.departamento})`;
      porOrgano.set(g, [...(porOrgano.get(g) ?? []), x]);
    }
    grupos = [...porOrgano].map(([grupo, xs]) => ({ grupo, convocatorias: xs.length, titulos_distintos: titulosDistintos(xs) }));
  } else {
    // En paralelo: el limitador de bdns.ts sigue marcando el ritmo de salida de las peticiones,
    // pero una respuesta lenta ya no retrasa las siguientes.
    grupos = await Promise.all(
      (await variantes(f, por, base)).map(async (v) => {
        const fv = { ...f, desde: v.desde ?? f.desde, hasta: v.hasta ?? f.hasta };
        const r = await coincidencias(fv, v.params, 0);
        return { grupo: v.grupo, convocatorias: r.total, titulos_distintos: r.todas ? titulosDistintos(r.todas) : null };
      }),
    );
    grupos = grupos.filter((g) => g.convocatorias > 0);
  }
  const fechaDesc = por === "mes" || por === "anio";
  grupos.sort((a, b) =>
    fechaDesc ? b.grupo.localeCompare(a.grupo) : b.convocatorias - a.convocatorias || a.grupo.localeCompare(b.grupo),
  );
  return { total, grupos: grupos.slice(0, limite) };
}
