// Memoria temporal de las respuestas de la BDNS, compartida entre consultas y sesiones.
//
// No es una copia de la BDNS: solo guarda lo que ya se ha preguntado, con una caducidad que
// depende de lo que puede cambiar. Vive en memoria y en un archivo SQLite pequeño (node:sqlite,
// sin dependencias) para servir también tras reiniciar el cliente MCP. Si el archivo no se
// puede usar (disco de solo lectura, por ejemplo), funciona solo en memoria.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// node:sqlite existe desde Node 22.13. Con un Node más antiguo (p. ej. el que trae un cliente
// MCP) el servidor debe seguir funcionando, solo que con la caché en memoria.
const sqlite: typeof import("node:sqlite") | null = await import("node:sqlite").catch(() => null);

export const RUTA_CACHE =
  process.env.AYUDAS_CACHE ?? path.join(os.homedir(), ".cache", "ayudas-es-mcp", "cache.sqlite");

/** Entradas en memoria: al pasar de aquí se descartan las más antiguas (siguen en disco). */
const MAX_MEMORIA = 2_000;
/** Entradas en disco: al pasar de aquí se borran las que antes iban a caducar. */
const MAX_DISCO = 20_000;
/** Lo que ocupa más que esto (listados enormes) solo se guarda en memoria. */
const MAX_BYTES_ENTRADA = 8 * 1024 * 1024;
/** Tamaño total en disco: al pasar de aquí se borran las entradas que antes iban a caducar. */
const MAX_BYTES_DISCO = 200 * 1024 * 1024;
let escriturasDesdePoda = 0;
let bytesDesdePoda = 0;

/** Borra lo caducado y, si sobra, lo que antes iba a caducar, hasta quedar dentro de los topes. */
function podar(d: DatabaseSync) {
  d.prepare("DELETE FROM cache WHERE caduca < ?").run(Date.now());
  d.prepare(
    "DELETE FROM cache WHERE clave IN (SELECT clave FROM cache ORDER BY caduca DESC LIMIT -1 OFFSET ?)",
  ).run(MAX_DISCO);
  d.prepare(
    `DELETE FROM cache WHERE clave IN (
       SELECT clave FROM (SELECT clave, SUM(length(valor)) OVER (ORDER BY caduca DESC) AS acumulado FROM cache)
       WHERE acumulado > ?)`,
  ).run(MAX_BYTES_DISCO);
}

type Entrada = { valor: unknown; caduca: number };
const memoria = new Map<string, Entrada>();
const enCurso = new Map<string, Promise<unknown>>();

let disco: DatabaseSync | null | undefined;

function abrirDisco(): DatabaseSync | null {
  if (disco !== undefined) return disco;
  if (!sqlite) return (disco = null);
  try {
    if (RUTA_CACHE !== ":memory:") fs.mkdirSync(path.dirname(RUTA_CACHE), { recursive: true });
    disco = new sqlite.DatabaseSync(RUTA_CACHE);
    disco.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS cache (clave TEXT PRIMARY KEY, valor TEXT NOT NULL, caduca INTEGER NOT NULL);
    `);
    // Al arrancar se borra lo caducado y lo que exceda los topes.
    podar(disco);
  } catch {
    disco = null;
  }
  return disco;
}

function enMemoria(clave: string, e: Entrada) {
  memoria.delete(clave);
  memoria.set(clave, e);
  if (memoria.size > MAX_MEMORIA) memoria.delete(memoria.keys().next().value!);
}

export function leer<T>(clave: string): T | undefined {
  const ahora = Date.now();
  const m = memoria.get(clave);
  if (m) {
    if (m.caduca > ahora) return m.valor as T;
    memoria.delete(clave);
  }
  try {
    const r = abrirDisco()
      ?.prepare("SELECT valor, caduca FROM cache WHERE clave = ? AND caduca > ?")
      .get(clave, ahora) as { valor: string; caduca: number } | undefined;
    if (!r) return undefined;
    const valor = JSON.parse(r.valor) as T;
    enMemoria(clave, { valor, caduca: r.caduca });
    return valor;
  } catch {
    return undefined;
  }
}

export function guardar(clave: string, valor: unknown, vigenciaMs: number) {
  if (vigenciaMs <= 0) return;
  const caduca = Date.now() + vigenciaMs;
  enMemoria(clave, { valor, caduca });
  try {
    const json = JSON.stringify(valor);
    const d = abrirDisco();
    if (!d || json.length > MAX_BYTES_ENTRADA) return;
    d.prepare("INSERT OR REPLACE INTO cache (clave, valor, caduca) VALUES (?, ?, ?)").run(clave, json, caduca);
    bytesDesdePoda += json.length;
    if (++escriturasDesdePoda >= 500 || bytesDesdePoda >= 20 * 1024 * 1024) {
      escriturasDesdePoda = bytesDesdePoda = 0;
      podar(d);
    }
  } catch {
    // Sin disco, la memoria basta.
  }
}

/** Entradas y tamaño de la caché en disco (para estado_datos). */
export function estadisticas(): { entradas: number; bytes: number; ruta: string } | null {
  try {
    const d = abrirDisco();
    if (!d) return null;
    const r = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(length(valor)), 0) AS b FROM cache WHERE caduca > ?").get(Date.now()) as {
      n: number;
      b: number;
    };
    return { entradas: r.n, bytes: r.b, ruta: RUTA_CACHE };
  } catch {
    return null;
  }
}

/**
 * El valor guardado o, si no lo hay, lo calcula, lo guarda y lo devuelve. Dos consultas que
 * piden lo mismo a la vez comparten la petición. La vigencia puede depender del valor.
 */
export async function recordar<T>(
  clave: string,
  vigencia: number | ((valor: T) => number),
  calcular: () => Promise<T>,
): Promise<T> {
  const guardado = leer<T>(clave);
  if (guardado !== undefined) return guardado;
  const pendiente = enCurso.get(clave);
  if (pendiente) return pendiente as Promise<T>;
  const p = calcular()
    .then((valor) => {
      guardar(clave, valor, typeof vigencia === "function" ? vigencia(valor) : vigencia);
      return valor;
    })
    .finally(() => enCurso.delete(clave));
  enCurso.set(clave, p);
  return p;
}

/** Vacía la memoria y el disco (para las pruebas). */
export function vaciar() {
  memoria.clear();
  try {
    abrirDisco()?.exec("DELETE FROM cache");
  } catch {
    // nada que vaciar
  }
}

/** Cierra el archivo (para las pruebas: en Windows no se puede borrar mientras está abierto). */
export function cerrar() {
  disco?.close();
  disco = undefined;
}

export const HORA = 3_600_000;
export const DIA = 24 * HORA;
