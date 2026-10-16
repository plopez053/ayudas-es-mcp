import { createRequire } from "node:module";

// Una sola fuente para la versión: package.json (está junto a src/ y dist/, y npm siempre lo publica).
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
export const NOMBRE = "ayudas-es-mcp";
