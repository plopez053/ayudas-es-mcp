// Pruebas de la caché sin red: caducidad, persistencia en disco y peticiones compartidas.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Un archivo temporal: la prueba no debe tocar la caché real del usuario.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ayudas-cache-"));
process.env.AYUDAS_CACHE = path.join(dir, "cache.sqlite");
const { guardar, leer, recordar, vaciar, cerrar, RUTA_CACHE } = await import("./cache.js");
assert.equal(RUTA_CACHE, process.env.AYUDAS_CACHE);

// Guardar y leer; caducidad.
guardar("a", { x: 1 }, 60_000);
assert.deepEqual(leer("a"), { x: 1 }, "un valor vigente se lee");
guardar("b", "viejo", -1);
assert.equal(leer("b"), undefined, "un valor caducado no se lee");

// Dos peticiones simultáneas comparten el cálculo.
let llamadas = 0;
const calcular = async () => {
  llamadas++;
  await new Promise((r) => setTimeout(r, 50));
  return "resultado";
};
const [r1, r2] = await Promise.all([recordar("c", 60_000, calcular), recordar("c", 60_000, calcular)]);
assert.equal(r1, "resultado");
assert.equal(r2, "resultado");
assert.equal(llamadas, 1, "las peticiones simultáneas no se duplican");

// Segunda consulta: sale de la caché.
assert.equal(await recordar("c", 60_000, calcular), "resultado");
assert.equal(llamadas, 1, "la segunda consulta sale de la caché");

// La vigencia puede depender del valor.
await recordar("d", (v) => (v === "corto" ? 1 : 60_000), async () => "corto");
await new Promise((r) => setTimeout(r, 10));
assert.equal(leer("d"), undefined, "la vigencia depende del valor");

// Si el cálculo falla, no se guarda nada y la siguiente vez se vuelve a intentar.
await assert.rejects(recordar("e", 60_000, async () => { throw new Error("BDNS caída"); }));
assert.equal(leer("e"), undefined, "un fallo no se guarda");
assert.equal(await recordar("e", 60_000, async () => "ok"), "ok");

// Persistencia: el valor sigue en disco si se borra la memoria. La memoria se limpia reabriendo
// el módulo en otro proceso, así que se comprueba con una consulta a la tabla directamente.
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(RUTA_CACHE);
const fila = db.prepare("SELECT valor FROM cache WHERE clave = 'a'").get() as { valor: string } | undefined;
db.close();
assert.equal(fila && JSON.parse(fila.valor).x, 1, "el valor se guarda en disco");

vaciar();
assert.equal(leer("a"), undefined, "vaciar borra la memoria y el disco");
cerrar();
fs.rmSync(dir, { recursive: true, force: true });
console.log("Caché: OK");
