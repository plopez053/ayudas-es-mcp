// Sincronización manual o programada (cron, Programador de tareas, GitHub Actions):
//
//   ayudas-es-mcp sync                         incremental (o el último año si la base está vacía)
//   ayudas-es-mcp sync --desde 2021-01-01      desde una fecha
//   ayudas-es-mcp sync --detalles 1000         y rellena hasta 1000 detalles (por defecto 500)

import { RUTA_DB, estadoBase } from "./db.js";
import { mantener } from "./sync.js";

const args = process.argv.slice(2);
const valor = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const log = (m: string) => console.log(`[${new Date().toLocaleTimeString("es-ES")}] ${m}`);

const detalles = valor("--detalles");
const desde = valor("--desde");
if (detalles !== undefined && !/^\d+$/.test(detalles)) throw new Error(`--detalles debe ser un número (recibido "${detalles}")`);
if (desde !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error(`--desde debe ser AAAA-MM-DD (recibido "${desde}")`);

log(`base: ${RUTA_DB}`);
const hecho = await mantener({
  desde,
  detalles: detalles === undefined ? undefined : Number(detalles),
  forzar: true,
  log,
});
if (!hecho) {
  console.error("Hay otra sincronización en curso (otro cliente MCP o terminal). Inténtalo más tarde.");
  process.exitCode = 1;
}
console.log(estadoBase());
