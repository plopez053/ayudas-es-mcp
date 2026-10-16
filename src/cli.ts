#!/usr/bin/env node
// Punto de entrada: arranca el servidor MCP (stdio).

const orden = process.argv[2];

if (orden === "--help" || orden === "-h") {
  console.log(`ayudas-es-mcp: servidor MCP de ayudas y subvenciones (BDNS) y del BOE

Uso:
  ayudas-es-mcp                  arranca el servidor MCP (lo lanza el cliente: Claude, Cursor...)
  ayudas-es-mcp --vaciar-cache   borra la caché local de respuestas
  ayudas-es-mcp --version        muestra la versión

Variables de entorno:
  AYUDAS_CACHE           ruta de la caché SQLite (por defecto ~/.cache/ayudas-es-mcp/cache.sqlite)
  BDNS_INTERVALO_MS      milisegundos entre peticiones a la BDNS (por defecto 1000)
  AYUDAS_TIMEOUT_MS      tiempo máximo de cada petición HTTP (por defecto 30000)`);
} else if (orden === "--version" || orden === "-v") {
  const { VERSION } = await import("./version.js");
  console.log(VERSION);
} else if (orden === "--vaciar-cache") {
  const { RUTA_CACHE, vaciar } = await import("./cache.js");
  vaciar();
  console.log(`Caché vaciada (${RUTA_CACHE})`);
} else if (orden) {
  console.error(`Opción desconocida "${orden}". Usa --help.`);
  process.exitCode = 1;
} else {
  await import("./index.js");
}
