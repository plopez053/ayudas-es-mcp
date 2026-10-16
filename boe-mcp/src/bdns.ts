// Cliente de la Base de Datos Nacional de Subvenciones (BDNS / infosubvenciones.es).
// Recoge las convocatorias de ayudas de TODAS las administraciones: Estado, CCAA y entes locales.
// Aviso legal de reutilización: https://www.infosubvenciones.es/bdnstrans/GE/es/avisolegal

import { ErrorDeRed, esperar, pedir } from "./red.js";
import { NOMBRE, VERSION } from "./version.js";

const API = "https://www.infosubvenciones.es/bdnstrans/api";
const WEB = "https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias";

/** Nombre de la comunidad tal y como aparece (código NUTS2) en el árbol de regiones de la BDNS. */
export const COMUNIDADES = {
  andalucia: "ES61",
  aragon: "ES24",
  asturias: "ES12",
  baleares: "ES53",
  canarias: "ES70",
  cantabria: "ES13",
  "castilla-la-mancha": "ES42",
  "castilla-y-leon": "ES41",
  cataluna: "ES51",
  ceuta: "ES63",
  "comunidad-valenciana": "ES52",
  extremadura: "ES43",
  galicia: "ES11",
  "la-rioja": "ES23",
  madrid: "ES30",
  melilla: "ES64",
  murcia: "ES62",
  navarra: "ES22",
  "pais-vasco": "ES21",
} as const;
export type Comunidad = keyof typeof COMUNIDADES;

/** Etiqueta para las ayudas de ámbito estatal (región "ES - ESPAÑA"). */
export const NACIONAL = "nacional";
const ID_ESPANA = 1;

export const BENEFICIARIOS = {
  "autonomo-o-pyme": 3,
  "gran-empresa": 4,
  "entidad-sin-actividad-economica": 2, // asociaciones, fundaciones, ayuntamientos...
  particular: 1,
} as const;
export type Beneficiario = keyof typeof BENEFICIARIOS;

export const FINALIDADES = {
  vivienda: 8,
  agricultura: 12,
  "comercio-turismo-pymes": 14,
  cultura: 11,
  desempleo: 7,
  educacion: 10,
  empleo: 6,
  "industria-energia": 13,
  "i+d+i": 17,
  sanidad: 9,
  "servicios-sociales": 5,
  transporte: 15,
  infraestructuras: 16,
  cooperacion: 20,
  "otras-economicas": 18,
  "otras-prestaciones": 4,
  justicia: 1,
  defensa: 2,
  "seguridad-ciudadana": 3,
} as const;
export type Finalidad = keyof typeof FINALIDADES;

export const INSTRUMENTOS = {
  subvencion: 1,
  prestamo: 2,
  garantia: 4,
  "ventaja-fiscal": 5,
  "financiacion-riesgo": 6,
  otros: 7,
} as const;
export type Instrumento = keyof typeof INSTRUMENTOS;

/** Valor de `nivel1` en la BDNS. */
export const ADMINISTRACIONES = {
  estatal: "ESTADO",
  autonomica: "AUTONOMICA",
  local: "LOCAL",
  otras: "OTROS", // universidades, consorcios, fundaciones públicas...
} as const;
export type Administracion = keyof typeof ADMINISTRACIONES;

export const urlFicha = (codigo: string) => `${WEB}/${codigo}`;

// --- Peticiones -----------------------------------------------------------------------------

/**
 * Limitador global: como mucho una petición cada INTERVALO_MS, venga de donde venga
 * (sincronización, relleno de detalles o una pregunta). La BDNS bloquea las ráfagas.
 */
const INTERVALO_MS = Number(process.env.BDNS_INTERVALO_MS ?? 1000);
let siguienteHueco = 0;
async function turno() {
  const ahora = Date.now();
  const espera = Math.max(0, siguienteHueco - ahora);
  siguienteHueco = Math.max(ahora, siguienteHueco) + INTERVALO_MS;
  if (espera) await esperar(espera);
}

const CABECERAS = {
  Accept: "application/json",
  "User-Agent": `${NOMBRE}/${VERSION} (servidor MCP de datos abiertos; sincronizacion diaria con limite de ritmo)`,
};

export class BdnsNoDisponible extends Error {}

/**
 * Petición a la BDNS con el limitador global. Los cortes de red y los timeouts se reintentan
 * igual que los bloqueos; si no se recupera, BdnsNoDisponible (nunca un error genérico que
 * tumbe una búsqueda entera).
 */
async function peticionBdns(
  url: string,
  accept: string,
  intentos: number,
  valida: (r: Response) => boolean,
  timeoutMs?: number,
) {
  let motivo = "";
  for (let i = 0; ; i++) {
    await turno();
    try {
      const res = await pedir(url, { headers: { ...CABECERAS, Accept: accept } }, timeoutMs);
      // 204 (sin contenido) es lo que responde la BDNS a un código que no existe: no es un bloqueo.
      if ((res.ok && valida(res)) || res.status === 404 || res.status === 204) return res;
      motivo = `HTTP ${res.status}`;
    } catch (e) {
      if (!(e instanceof ErrorDeRed)) throw e;
      motivo = e.message;
    }
    if (i + 1 >= intentos) {
      throw new BdnsNoDisponible(`BDNS no disponible o limitando peticiones (${motivo}). Reintenta en unos minutos.`);
    }
    await esperar(2000 * 2 ** i);
  }
}

/** Cuando bloquea, la BDNS devuelve una página HTML en lugar de JSON: se reintenta con espera. */
async function getJson(url: string, intentos = 5): Promise<any> {
  const res = await peticionBdns(url, "application/json", intentos, (r) =>
    Boolean(r.headers.get("content-type")?.includes("json")),
  );
  if (res.status === 404 || res.status === 204) throw new Error(`No existe en la BDNS (${url})`);
  return res.json();
}

const isoADma = (iso: string) => iso.split("-").reverse().join("/");

/**
 * Descarga un documento adjunto de una convocatoria (PDF, normalmente). Comparte el limitador
 * de peticiones con el resto de llamadas a la BDNS y rechaza archivos por encima de `maxBytes`.
 */
export async function descargarDocumento(idDocumento: string, maxBytes: number): Promise<Uint8Array> {
  if (!/^\d+$/.test(idDocumento)) throw new Error(`Identificador de documento inválido "${idDocumento}".`);
  const url = `${API}/convocatorias/documentos?idDocumento=${idDocumento}`;
  // Hasta 25 MB por un servidor a veces lento: más margen que una petición JSON.
  const res = await peticionBdns(url, "*/*", 4, (r) => !(r.headers.get("content-type") ?? "").includes("html"), 120_000);
  if (res.status === 404 || res.status === 204) throw new Error(`El documento ${idDocumento} ya no está en la BDNS.`);
  const declarado = Number(res.headers.get("content-length") ?? 0);
  if (declarado > maxBytes) {
    await res.body?.cancel();
    throw new Error(`El documento pesa ${(declarado / 1e6).toFixed(1)} MB (máximo ${maxBytes / 1e6} MB): ábrelo desde su enlace.`);
  }
  let datos: Uint8Array;
  try {
    datos = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new BdnsNoDisponible(`La descarga del documento se cortó (${(e as Error).message}). Reintenta en unos minutos.`);
  }
  if (datos.length > maxBytes) throw new Error(`El documento supera ${maxBytes / 1e6} MB: ábrelo desde su enlace.`);
  return datos;
}

function limpiarHtml(html: string): string {
  return html
    .replace(/<\/p>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Regiones -------------------------------------------------------------------------------

let arbolRegiones: Promise<any[]> | undefined;

/**
 * Ids de región de una comunidad. Las convocatorias se etiquetan a distintos niveles
 * (comunidad, provincia, y a veces el nivel NUTS1 superior) y el filtro de la API
 * no es jerárquico, así que se envían todos.
 */
export async function idsRegion(comunidad: Comunidad): Promise<number[]> {
  arbolRegiones ??= getJson(`${API}/regiones`).catch((e) => {
    arbolRegiones = undefined;
    throw e;
  });
  const arbol = await arbolRegiones;
  const codigo = COMUNIDADES[comunidad];

  const buscar = (nodos: any[], padre?: any): number[] | undefined => {
    for (const n of nodos) {
      if (String(n.descripcion).trim().startsWith(`${codigo} `)) {
        const ids: number[] = [];
        const recoger = (x: any) => {
          ids.push(x.id);
          x.children?.forEach(recoger);
        };
        recoger(n);
        // Comunidades uniprovinciales cuyo NUTS1 sólo contiene esa comunidad (p. ej. Madrid).
        if (padre && padre.children?.length === 1) ids.push(padre.id);
        return ids;
      }
      const r = buscar(n.children ?? [], n);
      if (r) return r;
    }
  };
  const ids = buscar(arbol);
  if (!ids) throw new Error(`No se encontró la región ${comunidad} en la BDNS.`);
  return ids;
}

// --- Listado masivo -------------------------------------------------------------------------

export interface FilaListado {
  codigo: string;
  titulo: string;
  titulo_cooficial: string | null;
  administracion: string;
  departamento: string;
  organo: string;
  fecha_registro: string;
  mrr: boolean;
}

/** La API no devuelve más de 10.000 filas por página, pida lo que se pida. */
const TAM_PAGINA = 10_000;

/**
 * Todas las convocatorias registradas entre dos fechas que cumplen los filtros de la API
 * (finalidad, tiposBeneficiario, regiones, instrumentos...), paginando de 10.000 en 10.000.
 */
export async function listar(
  filtros: Record<string, string>,
  desde: string,
  hasta: string,
): Promise<FilaListado[]> {
  const filas: FilaListado[] = [];
  for (let page = 0; ; page++) {
    const q = new URLSearchParams({
      ...filtros,
      page: String(page),
      pageSize: String(TAM_PAGINA),
      order: "numeroConvocatoria",
      direccion: "desc",
      fechaDesde: isoADma(desde),
      fechaHasta: isoADma(hasta),
    });
    const json = await getJson(`${API}/convocatorias/busqueda?${q}`);
    for (const c of json.content ?? []) {
      filas.push({
        codigo: String(c.numeroConvocatoria),
        titulo: c.descripcion ?? "",
        titulo_cooficial: c.descripcionLeng ?? null,
        administracion: c.nivel1 ?? "",
        departamento: c.nivel2 ?? "",
        organo: c.nivel3 ?? "",
        fecha_registro: c.fechaRecepcion,
        mrr: Boolean(c.mrr),
      });
    }
    if (json.last !== false) return filas;
  }
}

/** Parámetros de la API para listar las convocatorias de cada etiqueta que se guarda. */
export async function* consultasDeEtiquetas(): AsyncGenerator<{
  tipo: string;
  valor: string;
  filtros: Record<string, string>;
}> {
  for (const [valor, id] of Object.entries(FINALIDADES)) {
    yield { tipo: "finalidad", valor, filtros: { finalidad: String(id) } };
  }
  for (const [valor, id] of Object.entries(BENEFICIARIOS)) {
    yield { tipo: "beneficiario", valor, filtros: { tiposBeneficiario: String(id) } };
  }
  for (const [valor, id] of Object.entries(INSTRUMENTOS)) {
    yield { tipo: "instrumento", valor, filtros: { instrumentos: String(id) } };
  }
  yield { tipo: "comunidad", valor: NACIONAL, filtros: { regiones: String(ID_ESPANA) } };
  for (const c of Object.keys(COMUNIDADES) as Comunidad[]) {
    yield { tipo: "comunidad", valor: c, filtros: { regiones: (await idsRegion(c)).join(",") } };
  }
}

// --- Detalle --------------------------------------------------------------------------------

export interface AyudaDetalle {
  codigo: string;
  titulo: string;
  organo: string;
  fecha_registro: string;
  url: string;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  texto_inicio: string | null;
  texto_fin: string | null;
  /** Extractos publicados en boletines oficiales, del más antiguo al más reciente. */
  publicaciones: { diario: string; fecha: string; url: string | null }[];
  presupuesto: number | null;
  plazo: string;
  beneficiarios: string[];
  sectores: string[];
  regiones: string[];
  finalidad: string;
  tipo: string;
  instrumentos: string[];
  bases_reguladoras: string;
  extracto: string;
  documentos: { nombre: string; url: string }[];
}

export async function cargarDetalle(codigo: string): Promise<AyudaDetalle> {
  if (!/^\d+$/.test(codigo)) {
    throw new Error(`Código BDNS inválido "${codigo}". Es un número, p. ej. 932105.`);
  }
  const c = await getJson(`${API}/convocatorias?numConv=${codigo}`);
  const desc = (xs: any[] | undefined) =>
    (xs ?? []).map((x) => String(x.descripcion).trim()).filter(Boolean);

  const fIni: string | null = c.fechaInicioSolicitud ?? null;
  const fFin: string | null = c.fechaFinSolicitud ?? null;
  const inicio = fIni ?? c.textInicio?.trim();
  const fin = fFin ?? c.textFin?.trim();

  return {
    codigo,
    titulo: c.descripcion,
    organo: [c.organo?.nivel1, c.organo?.nivel2, c.organo?.nivel3].filter(Boolean).join(" › "),
    fecha_registro: c.fechaRecepcion,
    url: urlFicha(codigo),
    fecha_inicio: fIni,
    fecha_fin: fFin,
    texto_inicio: c.textInicio?.trim() || null,
    texto_fin: c.textFin?.trim() || null,
    publicaciones: (c.anuncios ?? [])
      .filter((a: any) => a.datPublicacion)
      .map((a: any) => ({ diario: a.desDiarioOficial ?? "boletín oficial", fecha: a.datPublicacion, url: a.url ?? null }))
      .sort((a: any, b: any) => a.fecha.localeCompare(b.fecha)),
    presupuesto: typeof c.presupuestoTotal === "number" ? c.presupuestoTotal : null,
    plazo: inicio || fin ? `Desde: ${inicio || "—"} · Hasta: ${fin || "—"}` : "No indicado",
    beneficiarios: desc(c.tiposBeneficiarios),
    sectores: desc(c.sectores),
    regiones: desc(c.regiones),
    finalidad: c.descripcionFinalidad ?? "",
    tipo: c.tipoConvocatoria ?? "",
    instrumentos: desc(c.instrumentos),
    bases_reguladoras: c.urlBasesReguladoras ?? c.descripcionBasesReguladoras ?? "",
    extracto: limpiarHtml((c.anuncios ?? []).map((a: any) => a.texto ?? "").join("\n\n")),
    documentos: (c.documentos ?? []).map((d: any) => ({
      nombre: d.descripcion || d.nombreFic,
      url: `${API}/convocatorias/documentos?idDocumento=${d.id}`,
    })),
  };
}

export const euros = (n: number | null) =>
  n === null ? "no indicado" : n.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
