// Verificación contra la fuente: los recuentos de la base local deben coincidir con los que da la
// API oficial de la BDNS en directo para los mismos filtros. Requiere red y una base sincronizada.
// Se excluyen los últimos 7 días, que aún pueden recibir registros con retraso.
import assert from "node:assert/strict";
import { BENEFICIARIOS, FINALIDADES, idsRegion, INSTRUMENTOS, type Comunidad } from "./bdns.js";
import { estadoBase, totalConFiltros, type Filtros } from "./db.js";

const base = estadoBase();
if (!base.ultima_sync || !base.desde) {
  console.log("Verificación: omitida (la base local aún no existe; ejecuta `npm run sync`)");
  process.exit(0);
}

const dia = 86_400_000;
const hasta = new Date(Date.now() - 7 * dia).toISOString().slice(0, 10);
const desde = new Date(Math.max(Date.parse(base.desde), Date.now() - 365 * dia)).toISOString().slice(0, 10);
const dma = (iso: string) => iso.split("-").reverse().join("/");
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function totalApi(params: Record<string, string>): Promise<number> {
  const q = new URLSearchParams({
    page: "0",
    pageSize: "1",
    fechaDesde: dma(desde),
    fechaHasta: dma(hasta),
    ...params,
  });
  for (let i = 0; i < 4; i++) {
    await esperar(1200);
    const r = await fetch(`https://www.infosubvenciones.es/bdnstrans/api/convocatorias/busqueda?${q}`, {
      headers: { Accept: "application/json" },
    });
    if (r.ok && r.headers.get("content-type")?.includes("json")) return (await r.json()).totalElements;
    await esperar(3000 * (i + 1));
  }
  throw new Error("La API de la BDNS no responde: no se puede verificar.");
}

const comunidad: Comunidad = "galicia";
const regionesGalicia = (await idsRegion(comunidad)).join(",");

const casos: { nombre: string; local: Filtros; api: Record<string, string> }[] = [
  { nombre: "todas", local: {}, api: {} },
  { nombre: "finalidad vivienda", local: { finalidad: "vivienda" }, api: { finalidad: String(FINALIDADES.vivienda) } },
  {
    nombre: "beneficiario pyme",
    local: { beneficiario: "autonomo-o-pyme" },
    api: { tiposBeneficiario: String(BENEFICIARIOS["autonomo-o-pyme"]) },
  },
  { nombre: "instrumento préstamo", local: { instrumento: "prestamo" }, api: { instrumentos: String(INSTRUMENTOS.prestamo) } },
  { nombre: "administración local", local: { administracion: "local" }, api: { tipoAdministracion: "L" } },
  {
    nombre: "galicia (sin estatales)",
    local: { comunidad, incluir_estatales: false },
    api: { regiones: regionesGalicia },
  },
  {
    nombre: "combinado: cultura + particulares + galicia",
    local: { finalidad: "cultura", beneficiario: "particular", comunidad, incluir_estatales: false },
    api: {
      finalidad: String(FINALIDADES.cultura),
      tiposBeneficiario: String(BENEFICIARIOS.particular),
      regiones: regionesGalicia,
    },
  },
];

let fallos = 0;
for (const c of casos) {
  const api = await totalApi(c.api);
  const local = totalConFiltros({ ...c.local, desde, hasta });
  const ok = local === api;
  if (!ok) fallos++;
  console.log(`${ok ? "✓" : "✗"} ${c.nombre.padEnd(44)} API ${String(api).padStart(6)}  local ${String(local).padStart(6)}`);
}
assert.equal(fallos, 0, `${fallos} recuentos de la base local no coinciden con la API oficial`);
console.log(`Verificación contra la BDNS (${desde} → ${hasta}): OK`);
