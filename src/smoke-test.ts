// Prueba de extremo a extremo: arranca el servidor por stdio y llama a cada herramienta
// contra las APIs reales. Con la caché vacía, la primera vez tarda unos minutos (el calendario
// descarga el histórico).
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { haceDias } from "./fechas.js";
import { contienePalabras, norm } from "./texto.js";

// --- Reglas de búsqueda por palabras ---------------------------------------------------------
const c = (t: string, ...p: string[]) => contienePalabras(norm(t), p);
assert.ok(!c("Instalación de placas", "tala"), "límite de palabra: 'tala' no está en 'instalación'");
assert.ok(c("Tala de árboles", "tala"));
assert.ok(c("Ayudas a pymes", "pyme") && c("Ayuda a la pyme", "pymes"), "singular/plural");
assert.ok(c("Subvenciones al comercio", "subvención"), "tildes y plural");
assert.ok(c("Plazas de enfermería", "enfermer*") && !c("Plazas de enfermería", "enfermer"), "prefijo con *");
assert.ok(c("Programa TIC para pymes", "tic") && !c("Estática", "tic"), "siglas cortas exactas");
assert.ok(c("Digitalización del comercio", "digital*"));
console.log("Reglas de búsqueda: OK\n");

// --- Herramientas ---------------------------------------------------------------------------
const client = new Client({ name: "smoke-test", version: "0.0.0" });
// Todo el entorno (el SDK solo pasa unas pocas variables): así AYUDAS_CACHE llega al servidor.
await client.connect(
  new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: process.env as Record<string, string> }),
);

const { tools } = await client.listTools();
console.log("HERRAMIENTAS:", tools.map((t) => t.name).join(", "), "\n");
assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), "todas las herramientas son de solo lectura");
assert.match(client.getInstructions() ?? "", /ayudas_recuento/, "el servidor envía instrucciones al modelo");
const { prompts } = await client.listPrompts();
assert.deepEqual(prompts.map((p) => p.name).sort(), ["analizar_convocatoria", "ayudas_para_mi"]);

let fallos = 0;
async function probar(name: string, args: Record<string, unknown>, chars = 1200) {
  const t0 = Date.now();
  const r: any = await client.callTool({ name, arguments: args });
  const text: string = r.content?.[0]?.text ?? "";
  if (r.isError) fallos++;
  console.log(`=== ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)${r.isError ? " ❌ ERROR" : ""}`);
  console.log(text.slice(0, chars), "\n");
  return text;
}

await probar("estado_datos", {});
await probar("boe_buscar", { secciones: ["2B"], palabras: ["enfermer*"], desde: haceDias(30) }, 500);

const lista = await probar("ayudas_buscar", { texto: "digital*", beneficiario: "autonomo-o-pyme", limite: 3 }, 2500);
const codigo = lista.match(/Código BDNS: (\d+)/)?.[1];
// Regresión: con coincidencias, la lista no puede salir vacía sin explicación (bug de NULL en SQL).
assert.ok(codigo || /ya están cerradas/.test(lista), "ayudas_buscar: total > 0 pero lista vacía");
if (codigo) await probar("ayuda_detalle", { codigo, max_caracteres_extracto: 600 }, 1200);

await probar("ayudas_recuento", { agrupar_por: "comunidad", finalidad: "vivienda", desde: "2026-01-01", limite: 8 }, 2000);
await probar("ayudas_recuento", { agrupar_por: "mes", beneficiario: "autonomo-o-pyme", desde: "2026-05-01" }, 1500);
await probar("ayudas_recuento", { agrupar_por: "organo", comunidad: "pais-vasco", incluir_estatales: false, texto: "euskera", limite: 5 }, 1500);
await probar("novedades_perfil", { comunidad: "galicia", beneficiario: "autonomo-o-pyme", palabras: ["hostelería", "comercio"], dias: 14 }, 2000);

// Calendario previsto: si aún se está preparando, lo dice (no "0 ayudas") y se espera.
for (let i = 0; ; i++) {
  const r: any = await client.callTool({ name: "ayudas_previstas", arguments: { dias: 30, limite: 1 } });
  if (!r.isError) break;
  assert.match(r.content?.[0]?.text ?? "", /preparando/, "sin calendario debe decir que se está preparando");
  assert.ok(i < 60, "el calendario no se ha preparado en 10 minutos");
  if (i === 0) console.log("(esperando a que se prepare el calendario...)");
  await new Promise((r) => setTimeout(r, 10_000));
}
await probar("ayudas_previstas", { comunidad: "pais-vasco", incluir_estatales: false, dias: 45, limite: 4 }, 3500);
await probar("ayudas_previstas", { beneficiario: "autonomo-o-pyme", finalidad: "comercio-turismo-pymes", dias: 90, limite: 3 }, 2500);

// Lectura de documentos (PDF real de una convocatoria; la 2ª llamada sale de la caché).
const doc = await probar("ayuda_texto", { codigo: "935035", temas: ["cuantia", "plazo"] }, 1500);
assert.match(doc, /LITERAL de un documento externo/, "debe avisar de que el texto es externo");
assert.match(doc, /p\. \d+/, "debe citar la página");
assert.match(doc, /6\.000/, "debe encontrar la cuantía del documento");
const t0 = Date.now();
await probar("ayuda_texto", { codigo: "935035", buscar: ["deportistas"] }, 400);
assert.ok(Date.now() - t0 < 2000, "la segunda consulta debe salir de la caché");
const inexistente = await client.callTool({ name: "ayuda_texto", arguments: { codigo: "999999999" } });
assert.ok((inexistente as { isError?: boolean }).isError, "un código inexistente debe ser un error claro");
assert.match(
  String((inexistente as { content?: { text?: string }[] }).content?.[0]?.text),
  /No existe/,
  "debe decir que no existe, no que la BDNS limita peticiones",
);

// Fiabilidad: el filtro de directas reduce el total y la respuesta avisa de que es una estimación.
const cultura = { agrupar_por: "anio", finalidad: "cultura", desde: "2026-01-01" };
const conDirectas = await probar("ayudas_recuento", cultura, 600);
const sinDirectas = await probar("ayudas_recuento", { ...cultura, excluir_directas: true }, 600);
const total = (t: string) => Number(t.match(/Total de convocatorias con estos filtros: (\d+)/)?.[1]);
assert.ok(total(sinDirectas) < total(conDirectas), "excluir_directas debe reducir el total");
assert.match(sinDirectas, /estimación/, "debe avisar de que es una estimación");
assert.match(conDirectas, /instrumentales/, "sin el filtro debe avisar de que incluye concesiones directas");

// Excluir directas en un periodo enorme exigiría descargar decenas de miles de filas: se pide acotar.
const enorme: any = await client.callTool({ name: "ayudas_recuento", arguments: { agrupar_por: "anio", desde: "2025-01-01", excluir_directas: true } });
assert.ok(enorme.isError && /Acota/.test(enorme.content?.[0]?.text), "debe pedir acotar en vez de descargar todo");

// La caché: repetir una consulta no vuelve a la BDNS.
const t1 = Date.now();
await probar("ayudas_recuento", { agrupar_por: "comunidad", finalidad: "vivienda", desde: "2026-01-01", limite: 8 }, 0);
assert.ok(Date.now() - t1 < 2000, "un recuento repetido debe salir de la caché");

// BOE: un domingo no se presenta como "no se publicó nada".
const domingo = await probar("boe_sumario_dia", { fecha: "2026-10-11" }, 300);
assert.match(domingo, /domingo/);

// Errores esperados: deben devolverse como error de herramienta, no tumbar el servidor.
await probar("ayuda_detalle", { codigo: "abc" }, 200);
await probar("boe_buscar", { desde: "2026-10-01" }, 200);

await client.close();
assert.equal(fallos, 2, `${fallos} herramientas fallaron; solo se esperaban los 2 errores provocados`);
console.log("OK: solo fallaron los 2 errores esperados");
