// Espejo local de la BDNS en SQLite (node:sqlite, sin dependencias).
//
// El listado masivo de la BDNS es barato (decenas de miles de filas por petición), pero el
// detalle de cada convocatoria cuesta una petición y la API bloquea las ráfagas. Por eso:
//   - convocatorias + etiquetas (finalidad, beneficiario, instrumento, comunidad) se sincronizan
//     en bloque con ~50 peticiones;
//   - el detalle (fechas, presupuesto...) se rellena poco a poco y se guarda.
// Las preguntas se responden contra esta base, no contra la API.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ADMINISTRACIONES,
  NACIONAL,
  type Administracion,
  type Beneficiario,
  type Comunidad,
  type FilaListado,
  type Finalidad,
  type Instrumento,
} from "./bdns.js";
import type { DetalleCompleto } from "./detalle.js";
import { hoy as hoyEspana } from "./fechas.js";
import { estadoDe, type Estado, type TipoPlazo } from "./plazos.js";
import { baseDePalabra, contienePalabras, esDirectaProbable, norm, palabrasDe } from "./texto.js";

/** Versión del detalle guardado: al subirla, los detalles antiguos se vuelven a pedir. */
export const VERSION_DETALLE = 2;

/** Huella de 48 bits de título + órgano: contar distintos con enteros es mucho más rápido que con texto. */
export function claveTitulo(textoBusqueda: string, organo: string): number {
  const h = createHash("sha1").update(`${textoBusqueda}|${organo}`).digest();
  return h.readUIntBE(0, 6);
}

export const RUTA_DB =
  process.env.BOE_MCP_DB ?? path.join(os.homedir(), ".boe-mcp", "bdns.sqlite");

let db: DatabaseSync | undefined;

export function abrir(): DatabaseSync {
  if (db) return db;
  if (RUTA_DB !== ":memory:") fs.mkdirSync(path.dirname(RUTA_DB), { recursive: true });
  db = new DatabaseSync(RUTA_DB);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;

    CREATE TABLE IF NOT EXISTS convocatorias (
      codigo           TEXT PRIMARY KEY,
      titulo           TEXT NOT NULL,
      titulo_cooficial TEXT,
      texto_busqueda   TEXT NOT NULL,  -- título + título cooficial, normalizados
      administracion   TEXT NOT NULL,  -- ESTADO | AUTONOMICA | LOCAL | OTROS
      departamento     TEXT,
      organo           TEXT,
      fecha_registro   TEXT NOT NULL,
      mrr              INTEGER NOT NULL DEFAULT 0,
      visto_en         TEXT NOT NULL,
      -- detalle (NULL hasta que se pide)
      detalle_json     TEXT,
      detalle_en       TEXT,
      fecha_inicio     TEXT,
      fecha_fin        TEXT,
      presupuesto      REAL
    );
    CREATE INDEX IF NOT EXISTS conv_fecha ON convocatorias(fecha_registro);
    -- COUNT(detalle_en) sin este índice recorre toda la tabla (378.000 filas) en cada pregunta.
    CREATE INDEX IF NOT EXISTS conv_detalle ON convocatorias(detalle_en);

    CREATE TABLE IF NOT EXISTS etiquetas (
      codigo TEXT NOT NULL,
      tipo   TEXT NOT NULL,  -- finalidad | beneficiario | instrumento | comunidad
      valor  TEXT NOT NULL,
      PRIMARY KEY (codigo, tipo, valor)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS etiq_valor ON etiquetas(tipo, valor, codigo);

    CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT);
  `);
  // Columnas añadidas después de la primera versión de la base.
  const columnas = new Set(
    (db.prepare("PRAGMA table_info(convocatorias)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const [col, tipo] of [
    ["detalle_version", "INTEGER"],
    ["plazo_tipo", "TEXT"], // TipoPlazo de plazos.ts
    ["plazo_inicio", "TEXT"],
    ["plazo_fin", "TEXT"], // fecha de fin explícita, escrita en el texto o calculada
    ["directa_probable", "INTEGER"], // estimación por el título: concesión directa o nominativa
    ["clave_titulo", "INTEGER"], // huella de título + órgano, para contar «títulos distintos» sin comparar cadenas
  ]) {
    if (!columnas.has(col)) db.exec(`ALTER TABLE convocatorias ADD COLUMN ${col} ${tipo}`);
  }
  // Ayudas aún abiertas registradas hace meses: solo las que tienen plazo (unos miles), sin recorrer la tabla.
  db.exec("CREATE INDEX IF NOT EXISTS conv_plazo_fin ON convocatorias(plazo_fin) WHERE plazo_fin IS NOT NULL");
  // Relleno de la huella en las filas anteriores a que existiera la columna (una sola vez).
  if (db.prepare("SELECT 1 FROM convocatorias WHERE clave_titulo IS NULL LIMIT 1").get()) {
    const upd = db.prepare("UPDATE convocatorias SET clave_titulo = ? WHERE codigo = ?");
    db.exec("BEGIN");
    for (const r of db
      .prepare("SELECT codigo, texto_busqueda, organo FROM convocatorias WHERE clave_titulo IS NULL")
      .all() as { codigo: string; texto_busqueda: string; organo: string }[]) {
      upd.run(claveTitulo(r.texto_busqueda, r.organo), r.codigo);
    }
    db.exec("COMMIT");
  }
  // Relleno de la estimación en las filas anteriores a que existiera la columna.
  if (db.prepare("SELECT 1 FROM convocatorias WHERE directa_probable IS NULL LIMIT 1").get()) {
    const upd = db.prepare("UPDATE convocatorias SET directa_probable = ? WHERE codigo = ?");
    db.exec("BEGIN");
    for (const r of db
      .prepare("SELECT codigo, titulo FROM convocatorias WHERE directa_probable IS NULL")
      .all() as { codigo: string; titulo: string }[]) {
      upd.run(esDirectaProbable(r.titulo) ? 1 : 0, r.codigo);
    }
    db.exec("COMMIT");
  }
  // Búsqueda por palabras con las reglas de texto.ts (límite de palabra, plural, prefijo).
  // La lista de palabras es la misma en todas las filas de una consulta: se parsea una vez.
  let ultima: { json: string; palabras: string[] } | undefined;
  db.function("contiene", { deterministic: true }, (texto, palabras) => {
    const json = String(palabras);
    if (ultima?.json !== json) ultima = { json, palabras: JSON.parse(json) };
    return contienePalabras(String(texto), ultima.palabras) ? 1 : 0;
  });
  return db;
}

export function leerMeta(clave: string): string | undefined {
  const r = abrir().prepare("SELECT valor FROM meta WHERE clave = ?").get(clave) as
    | { valor: string }
    | undefined;
  return r?.valor;
}

export function escribirMeta(clave: string, valor: string) {
  abrir().prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run(clave, valor);
}

/**
 * Cerrojo entre procesos (varios clientes MCP pueden compartir la misma base): evita que dos
 * instancias sincronicen a la vez y dupliquen el ritmo de peticiones a la BDNS. Caduca solo,
 * por si un proceso muere sin soltarlo.
 */
export function tomarCerrojo(nombre: string, minutos: number): boolean {
  const ahora = Date.now();
  const r = abrir()
    .prepare(
      `INSERT INTO meta (clave, valor) VALUES (?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
       WHERE CAST(meta.valor AS INTEGER) < ?`,
    )
    .run(`cerrojo_${nombre}`, String(ahora + minutos * 60_000), ahora);
  return Number(r.changes) > 0;
}

export function soltarCerrojo(nombre: string) {
  abrir().prepare("UPDATE meta SET valor = '0' WHERE clave = ?").run(`cerrojo_${nombre}`);
}

export function cerrojoTomado(nombre: string): boolean {
  return Number(leerMeta(`cerrojo_${nombre}`) ?? 0) > Date.now();
}

function enTransaccion<T>(fn: () => T): T {
  const d = abrir();
  d.exec("BEGIN");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

// --- Escritura ------------------------------------------------------------------------------

/** Inserta o actualiza los datos del listado sin tocar el detalle ya guardado. */
export function guardarListado(filas: FilaListado[]): number {
  const ahora = new Date().toISOString();
  const st = abrir().prepare(`
    INSERT INTO convocatorias
      (codigo, titulo, titulo_cooficial, texto_busqueda, administracion, departamento, organo,
       fecha_registro, mrr, visto_en, directa_probable, clave_titulo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(codigo) DO UPDATE SET
      titulo = excluded.titulo, titulo_cooficial = excluded.titulo_cooficial,
      texto_busqueda = excluded.texto_busqueda, administracion = excluded.administracion,
      departamento = excluded.departamento, organo = excluded.organo,
      fecha_registro = excluded.fecha_registro, mrr = excluded.mrr, visto_en = excluded.visto_en,
      directa_probable = excluded.directa_probable, clave_titulo = excluded.clave_titulo
  `);
  return enTransaccion(() => {
    for (const f of filas) {
      const textoBusqueda = norm(`${f.titulo} ${f.titulo_cooficial ?? ""}`);
      st.run(
        f.codigo,
        f.titulo,
        f.titulo_cooficial,
        textoBusqueda,
        f.administracion,
        f.departamento,
        f.organo,
        f.fecha_registro,
        f.mrr ? 1 : 0,
        ahora,
        esDirectaProbable(f.titulo) ? 1 : 0,
        claveTitulo(textoBusqueda, f.organo),
      );
    }
    return filas.length;
  });
}

export function guardarEtiquetas(codigos: string[], tipo: string, valor: string) {
  const st = abrir().prepare("INSERT OR IGNORE INTO etiquetas VALUES (?, ?, ?)");
  enTransaccion(() => {
    for (const c of codigos) st.run(c, tipo, valor);
  });
}

/**
 * Guarda el detalle. Con `descargado = false` (solo se ha reinterpretado el plazo) se conserva
 * la fecha de descarga, que decide cuándo volver a pedirlo a la BDNS.
 */
export function guardarDetalle(d: DetalleCompleto, descargado = true) {
  const p = d.plazo_interpretado;
  abrir()
    .prepare(
      `UPDATE convocatorias SET detalle_json = ?, detalle_en = COALESCE(?, detalle_en), detalle_version = ?,
         fecha_inicio = ?, fecha_fin = ?, presupuesto = ?,
         plazo_tipo = ?, plazo_inicio = ?, plazo_fin = ?
       WHERE codigo = ?`,
    )
    .run(
      JSON.stringify(d),
      descargado ? new Date().toISOString() : null,
      VERSION_DETALLE,
      d.fecha_inicio,
      d.fecha_fin,
      d.presupuesto,
      p.tipo,
      p.inicio,
      p.fin,
      d.codigo,
    );
}

// --- Lectura --------------------------------------------------------------------------------

/** Detalle guardado con el formato actual (los de versiones anteriores se vuelven a pedir). */
export function leerDetalle(codigo: string): { detalle: DetalleCompleto; en: string } | undefined {
  const r = abrir()
    .prepare("SELECT detalle_json, detalle_en, detalle_version FROM convocatorias WHERE codigo = ?")
    .get(codigo) as
    | { detalle_json: string | null; detalle_en: string | null; detalle_version: number | null }
    | undefined;
  if (!r?.detalle_json || r.detalle_version !== VERSION_DETALLE) return undefined;
  return { detalle: JSON.parse(r.detalle_json), en: r.detalle_en! };
}

/**
 * Todos los detalles guardados con el formato actual. Primero se leen los códigos y luego
 * cada detalle, para poder actualizar la tabla mientras se recorre.
 */
export function* detallesGuardados(): Generator<DetalleCompleto> {
  const d = abrir();
  const codigos = (
    d
      .prepare("SELECT codigo FROM convocatorias WHERE detalle_version = ? AND detalle_json IS NOT NULL")
      .all(VERSION_DETALLE) as { codigo: string }[]
  ).map((r) => r.codigo);
  const st = d.prepare("SELECT detalle_json FROM convocatorias WHERE codigo = ?");
  for (const c of codigos) {
    yield JSON.parse((st.get(c) as { detalle_json: string }).detalle_json);
  }
}

/** La comunidad de una convocatoria si es de una sola (para aplicar sus festivos). */
export function comunidadUnica(codigo: string): string | null {
  const filas = abrir()
    .prepare("SELECT valor FROM etiquetas WHERE codigo = ? AND tipo = 'comunidad' AND valor != ?")
    .all(codigo, NACIONAL) as { valor: string }[];
  return filas.length === 1 ? filas[0].valor : null;
}

/**
 * Convocatorias sin detalle (o con uno de una versión anterior) y recientes cuyo plazo
 * todavía puede concretarse: se publica el extracto y el plazo pasa a poder calcularse.
 * Primero las que se pueden solicitar: el 98 % de las que el título delata como concesión
 * directa lo confirma su detalle, así que pedirlas antes gastaría la mitad del cupo en nada.
 */
export function pendientesDeDetalle(max: number): string[] {
  const hoy = new Date();
  const hace = (dias: number) => new Date(hoy.getTime() - dias * 86_400_000).toISOString();
  const filas = abrir()
    .prepare(
      `SELECT codigo FROM convocatorias
       WHERE detalle_en IS NULL
          OR detalle_version IS NOT ?
          OR (plazo_tipo IN ('pendiente_publicacion', 'desconocido')
              AND fecha_registro >= ? AND detalle_en < ?)
       ORDER BY COALESCE(directa_probable, 0), fecha_registro DESC, codigo DESC
       LIMIT ?`,
    )
    .all(VERSION_DETALLE, hace(60).slice(0, 10), hace(2), max) as { codigo: string }[];
  return filas.map((f) => f.codigo);
}

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
  /**
   * Excluir las concesiones directas: las que el detalle confirma como tales y, si aún no hay
   * detalle, las que el título delata (estimación con 97 % de precisión y 67 % de cobertura).
   */
  excluir_directas?: boolean;
  /** Solo las que tienen una fecha de fin de plazo conocida que no ha pasado. */
  solo_plazo_vigente?: boolean;
}

/** Condiciones SQL (sobre la tabla convocatorias con alias `c`) para unos filtros. */
export function where(f: Filtros): { sql: string; params: (string | number)[] } {
  const c: string[] = [];
  const p: (string | number)[] = [];
  const etiqueta = (tipo: string, valores: string[]) => {
    c.push(
      `EXISTS (SELECT 1 FROM etiquetas e WHERE e.codigo = c.codigo AND e.tipo = ?
               AND e.valor IN (${valores.map(() => "?").join(",")}))`,
    );
    p.push(tipo, ...valores);
  };
  if (f.desde) (c.push("c.fecha_registro >= ?"), p.push(f.desde));
  if (f.hasta) (c.push("c.fecha_registro <= ?"), p.push(f.hasta));
  if (f.administracion) (c.push("c.administracion = ?"), p.push(ADMINISTRACIONES[f.administracion]));
  if (f.comunidad) {
    etiqueta("comunidad", f.incluir_estatales === false ? [f.comunidad] : [f.comunidad, NACIONAL]);
  }
  if (f.beneficiario) etiqueta("beneficiario", [f.beneficiario]);
  if (f.finalidad) etiqueta("finalidad", [f.finalidad]);
  if (f.instrumento) etiqueta("instrumento", [f.instrumento]);
  if (f.texto?.trim()) {
    const palabras = palabrasDe(f.texto);
    // Prefiltro nativo (instr) antes de la regex en JavaScript: necesario pero no suficiente.
    for (const w of palabras) {
      const base = baseDePalabra(w);
      if (base) (c.push("instr(c.texto_busqueda, ?) > 0"), p.push(base));
    }
    c.push("contiene(c.texto_busqueda, ?)");
    p.push(JSON.stringify(palabras));
  }
  if (f.excluir_directas) {
    c.push("NOT (COALESCE(c.plazo_tipo, '') = 'sin_plazo' OR (c.detalle_en IS NULL AND c.directa_probable = 1))");
  }
  if (f.solo_plazo_vigente) {
    c.push("c.plazo_fin >= ? AND COALESCE(c.plazo_tipo, '') != 'sin_plazo'");
    p.push(hoyEspana());
  }
  return { sql: c.length ? `WHERE ${c.join(" AND ")}` : "", params: p };
}

export interface FilaBusqueda {
  codigo: string;
  titulo: string;
  administracion: string;
  departamento: string;
  organo: string;
  fecha_registro: string;
  estado: Estado | null; // null si aún no hay detalle
}

// Convocatorias en las que ya no se puede solicitar: plazo vencido o sin solicitud.
// COALESCE: sin él, las que aún no tienen el plazo analizado (NULL) hacen que NOT(...) sea
// NULL y se descartan todas.
const NO_SOLICITABLE = `(COALESCE(c.plazo_tipo, '') = 'sin_plazo' OR COALESCE(c.plazo_fin, '9999') < ?)`;

/** Total exacto de coincidencias y las más recientes, descartando las no solicitables conocidas. */
export function buscar(
  f: Filtros,
  limite: number,
  soloSolicitables: boolean,
): { total: number; cerradas: number; sin_plazo: number; filas: FilaBusqueda[] } {
  const d = abrir();
  const hoy = hoyEspana();
  const w = where(f);
  const cuenta = d
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(COALESCE(c.plazo_tipo, '') != 'sin_plazo' AND COALESCE(c.plazo_fin, '9999') < ?) AS cerradas,
              SUM(COALESCE(c.plazo_tipo, '') = 'sin_plazo') AS sin_plazo
       FROM convocatorias c ${w.sql}`,
    )
    .get(hoy, ...w.params) as { total: number; cerradas: number | null; sin_plazo: number | null };

  const filtro = soloSolicitables ? `${w.sql ? "AND" : "WHERE"} NOT ${NO_SOLICITABLE}` : "";
  const filas = d
    .prepare(
      `SELECT c.codigo, c.titulo, c.administracion, c.departamento, c.organo, c.fecha_registro,
              c.detalle_version = ? AS al_dia, c.plazo_tipo, c.plazo_inicio, c.plazo_fin
       FROM convocatorias c ${w.sql} ${filtro}
       ORDER BY c.fecha_registro DESC, c.codigo DESC
       LIMIT ?`,
    )
    .all(VERSION_DETALLE, ...w.params, ...(soloSolicitables ? [hoy] : []), limite) as any[];

  return {
    total: cuenta.total,
    cerradas: cuenta.cerradas ?? 0,
    sin_plazo: cuenta.sin_plazo ?? 0,
    filas: filas.map((r) => ({
      codigo: r.codigo,
      titulo: r.titulo,
      administracion: r.administracion,
      departamento: r.departamento,
      organo: r.organo,
      fecha_registro: r.fecha_registro,
      estado: r.al_dia
        ? estadoDe({ tipo: r.plazo_tipo as TipoPlazo, inicio: r.plazo_inicio, fin: r.plazo_fin }, hoy)
        : null,
    })),
  };
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

export interface GrupoRecuento {
  grupo: string;
  convocatorias: number;
  titulos_distintos: number;
  presupuesto_conocido: number;
  con_presupuesto: number;
}

/** Recuento exacto sobre la base local, agrupado. */
export function recuento(f: Filtros, por: Agrupacion, limite: number): GrupoRecuento[] {
  const w = where(f);
  const porEtiqueta = ["comunidad", "finalidad", "beneficiario", "instrumento"].includes(por);
  const expr: Record<Agrupacion, string> = {
    comunidad: "e.valor",
    finalidad: "e.valor",
    beneficiario: "e.valor",
    instrumento: "e.valor",
    administracion: "c.administracion",
    organo: "c.organo || ' (' || c.departamento || ')'",
    mes: "substr(c.fecha_registro, 1, 7)",
    anio: "substr(c.fecha_registro, 1, 4)",
  };
  const orden = por === "mes" || por === "anio" ? "grupo DESC" : "convocatorias DESC, grupo";
  // Primero se seleccionan las convocatorias que cumplen los filtros y luego se agrupan por
  // etiqueta. Sin esto, SQLite empieza por todas las etiquetas del tipo (250.000 filas) y filtra
  // después: 1,8 s en lugar de unas décimas.
  const join = porEtiqueta ? `JOIN etiquetas e ON e.codigo = c.codigo AND e.tipo = '${por}'` : "";
  return abrir()
    .prepare(
      `WITH c AS MATERIALIZED (
         SELECT c.codigo, c.clave_titulo, c.organo, c.departamento, c.administracion,
                c.fecha_registro, c.presupuesto
         FROM convocatorias c ${w.sql}
       )
       SELECT ${expr[por]} AS grupo,
              COUNT(DISTINCT c.codigo) AS convocatorias,
              COUNT(DISTINCT c.clave_titulo) AS titulos_distintos,
              COALESCE(SUM(c.presupuesto), 0) AS presupuesto_conocido,
              COUNT(c.presupuesto) AS con_presupuesto
       FROM c ${join}
       GROUP BY grupo ORDER BY ${orden} LIMIT ?`,
    )
    .all(...w.params, limite) as unknown as GrupoRecuento[];
}

export function totalConFiltros(f: Filtros): number {
  const w = where(f);
  return (abrir().prepare(`SELECT COUNT(*) AS n FROM convocatorias c ${w.sql}`).get(...w.params) as {
    n: number;
  }).n;
}

export interface EstadoBase {
  convocatorias: number;
  con_detalle: number;
  desde: string | null;
  hasta: string | null;
  ultima_sync: string | null;
}

let estadoEnCache: { en: number; valor: EstadoBase } | undefined;

/** Estado de la base. Se guarda 30 s: todas las herramientas lo consultan para avisar de la cobertura. */
export function estadoBase(): EstadoBase {
  if (estadoEnCache && Date.now() - estadoEnCache.en < 30_000) return estadoEnCache.valor;
  const r = abrir()
    .prepare(
      `SELECT COUNT(*) AS convocatorias, COUNT(detalle_en) AS con_detalle FROM convocatorias`,
    )
    .get() as { convocatorias: number; con_detalle: number };
  const valor = {
    ...r,
    desde: leerMeta("ventana_desde") ?? null,
    hasta: leerMeta("ventana_hasta") ?? null,
    ultima_sync: leerMeta("ultima_sync") ?? null,
  };
  estadoEnCache = { en: Date.now(), valor };
  return valor;
}
