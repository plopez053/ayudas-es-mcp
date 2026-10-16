#!/usr/bin/env node
// Punto de entrada: sin argumentos arranca el servidor MCP (stdio); con `sync`, sincroniza la base.

const orden = process.argv[2];

if (orden === "--help" || orden === "-h") {
  console.log(`ayudas-es-mcp: servidor MCP de ayudas y subvenciones (BDNS) y del BOE

Uso:
  ayudas-es-mcp                  arranca el servidor MCP (lo lanza el cliente: Claude, Cursor...)
  ayudas-es-mcp sync [opciones]  sincroniza la base local de la BDNS
      --desde AAAA-MM-DD         sincroniza desde esa fecha (por defecto, incremental)
      --detalles N               rellena hasta N detalles de convocatorias (por defecto 500)

Variables de entorno:
  BOE_MCP_DB             ruta de la base SQLite (por defecto ~/.boe-mcp/bdns.sqlite)
  BDNS_INTERVALO_MS      milisegundos entre peticiones a la BDNS (por defecto 1000)
  AYUDAS_TIMEOUT_MS      tiempo máximo de cada petición HTTP (por defecto 30000)`);
} else if (orden === "--version" || orden === "-v") {
  const { VERSION } = await import("./version.js");
  console.log(VERSION);
} else if (orden === "sync") {
  await import("./sync-cli.js");
} else {
  await import("./index.js");
}
