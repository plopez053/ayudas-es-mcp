// Prototipo sin base local: comprueba que las consultas en directo dan lo mismo que la base y
// mide cuánto tardan. Requiere red.
//
// Referencia: lo que haría la base local. Se descarga el listado completo con los filtros de la
// API y SIN las palabras (como la sincronización) y se aplican aquí las reglas de texto.ts.
// La versión en directo envía las palabras a la API y filtra solo lo que esta devuelve.
import assert from "node:assert/strict";
import type { Filtros } from "./directo.js";

// Caché solo en memoria: las medidas son de la primera consulta, y no se toca la del usuario.
process.env.AYUDAS_CACHE = ":memory:";
const { listar } = await import("./bdns.js");
const { buscarDirecto, coste, cumple, parametros, recuentoDirecto } = await import("./directo.js");
const { haceDias } = await import("./fechas.js");

async function medir<T>(nombre: string, fn: () => Promise<T>): Promise<T> {
  coste.peticiones = 0;
  const t0 = Date.now();
  const r = await fn();
  console.log(`  ${nombre}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${coste.peticiones} peticiones`);
  return r;
}

// --- 1. Equivalencia de la búsqueda por palabras --------------------------------------------
console.log("1. Búsqueda por palabras: API + reglas locales = base local");
const casos: Filtros[] = [
  { texto: "digital*", beneficiario: "autonomo-o-pyme", desde: "2026-07-01", hasta: "2026-09-30" },
  { texto: "pymes", desde: "2026-09-01", hasta: "2026-09-30" },
  { texto: "tala", desde: "2026-06-01", hasta: "2026-09-30" }, // la API también trae «instalación»
  { texto: "tic", desde: "2026-06-01", hasta: "2026-09-30" }, // sigla corta: exacta
  { texto: "euskera", comunidad: "pais-vasco", incluir_estatales: false, desde: "2026-01-01", hasta: "2026-09-30" },
  { texto: "dirulaguntza", desde: "2026-09-01", hasta: "2026-09-30" }, // solo en el título cooficial
  { texto: "vivienda alquiler", comunidad: "madrid", desde: "2026-01-01", hasta: "2026-09-30" },
  { excluir_directas: true, finalidad: "cultura", desde: "2026-09-01", hasta: "2026-09-30" },
];
let fallos = 0;
for (const f of casos) {
  const { texto, ...sinTexto } = f;
  const referencia = (await listar(await parametros(sinTexto), f.desde, f.hasta)).filter((x) => cumple(x, f)).length;
  const directo = (await recuentoDirecto(f, "anio", 1)).total;
  const ok = directo === referencia;
  if (!ok) fallos++;
  console.log(`  ${ok ? "✓" : "✗"} ${JSON.stringify(f).padEnd(110)} base ${String(referencia).padStart(5)}  directo ${String(directo).padStart(5)}`);
}
assert.equal(fallos, 0, `${fallos} búsquedas por palabras no coinciden`);

// --- 2. Tiempos de las consultas de la prueba de humo ---------------------------------------
console.log("\n2. Tiempos (a 1 petición/s, el ritmo que tolera la BDNS)");

const b1 = await medir("buscar 'digital*' pymes, 3 abiertas", () =>
  buscarDirecto({ texto: "digital*", beneficiario: "autonomo-o-pyme", desde: haceDias(90), excluir_directas: true }, 3, true),
);
console.log(`    total ${b1.total}, mostradas ${b1.visibles.length}, revisadas ${b1.revisadas} (cerradas ${b1.cerradas}, sin solicitud ${b1.sin_plazo})`);

const b2 = await medir("buscar Galicia, 10 abiertas", () =>
  buscarDirecto({ comunidad: "galicia", desde: haceDias(90), excluir_directas: true }, 10, true),
);
console.log(`    total ${b2.total}, mostradas ${b2.visibles.length}, revisadas ${b2.revisadas} (cerradas ${b2.cerradas}, sin solicitud ${b2.sin_plazo})`);

await medir("buscar Galicia otra vez (detalles en caché)", () =>
  buscarDirecto({ comunidad: "galicia", desde: haceDias(90), excluir_directas: true }, 10, true),
);

const r1 = await medir("recuento por comunidad, vivienda 2026", () =>
  recuentoDirecto({ finalidad: "vivienda", desde: "2026-01-01" }, "comunidad", 8),
);
console.log(`    total ${r1.total}: ${r1.grupos.map((g) => `${g.grupo} ${g.convocatorias}`).join(", ")}`);

const r2 = await medir("recuento por mes, pymes desde mayo", () =>
  recuentoDirecto({ beneficiario: "autonomo-o-pyme", desde: "2026-05-01" }, "mes", 20),
);
console.log(`    ${r2.grupos.map((g) => `${g.grupo} ${g.convocatorias}`).join(", ")}`);

const r3 = await medir("recuento por órgano, 'euskera' País Vasco", () =>
  recuentoDirecto({ texto: "euskera", comunidad: "pais-vasco", incluir_estatales: false }, "organo", 5),
);
console.log(`    total ${r3.total}: ${r3.grupos.map((g) => `${g.grupo.slice(0, 40)} ${g.convocatorias}/${g.titulos_distintos}`).join("; ")}`);

const r4 = await medir("recuento por año desde 2026, excluyendo directas", () =>
  recuentoDirecto({ desde: "2026-01-01", excluir_directas: true }, "anio", 5).catch((e) => ({ error: (e as Error).message })),
);
console.log(`    ${JSON.stringify(r4).slice(0, 200)}`);

console.log("\nOK: las búsquedas por palabras coinciden con la base local");
