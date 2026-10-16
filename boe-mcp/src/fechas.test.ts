// Pruebas sin red de las fechas en hora española y de los errores de red.
import assert from "node:assert/strict";
import { haceDias, hoy, sumarDias } from "./fechas.js";
import { ErrorDeRed, pedir } from "./red.js";

assert.match(hoy(), /^\d{4}-\d{2}-\d{2}$/);
assert.equal(sumarDias("2026-02-28", 1), "2026-03-01");
assert.equal(sumarDias("2028-02-28", 1), "2028-02-29", "año bisiesto");
assert.equal(sumarDias("2026-01-01", -1), "2025-12-31");
assert.equal(haceDias(0), hoy());

// A las 23:30 UTC del 14 de octubre ya es 15 de octubre en Madrid (UTC+2 en verano).
const madrid = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid" });
assert.equal(madrid.format(new Date("2026-10-14T23:30:00Z")), "2026-10-15");
// Y en invierno (UTC+1), a las 23:30 UTC del 14 de diciembre ya es 15.
assert.equal(madrid.format(new Date("2026-12-14T23:30:00Z")), "2026-12-15");

// Un host inexistente o un timeout se convierten en ErrorDeRed (reintentable), no en un error genérico.
await assert.rejects(pedir("http://127.0.0.1:9/", {}, 2000), ErrorDeRed);

console.log("fechas.test: OK");
