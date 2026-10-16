// Pruebas del cálculo de plazos con casos comprobados a mano.
import assert from "node:assert/strict";
import { duracionEnTexto, fechasEnTexto, interpretarPlazo, vencimiento, type Festivos } from "./plazos.js";

// Calendario fijo para que las pruebas no dependan de la red: festivos de 2026 relevantes.
const fest = (...dias: string[]): Festivos => async () => new Set(dias);
const nacional = fest("2026-10-12", "2026-11-01", "2026-12-06", "2026-12-08", "2026-12-25");

// Duraciones
assert.deepEqual(duracionEnTexto("Diez (10) días hábiles"), { n: 10, unidad: "habiles" });
assert.deepEqual(duracionEnTexto("15 DÍAS NATURALES DESDE EL INICIO"), { n: 15, unidad: "naturales" });
assert.deepEqual(duracionEnTexto("veinte días desde la publicación"), { n: 20, unidad: "habiles" }); // hábiles por ley
assert.deepEqual(duracionEnTexto("Un mes a contar desde el día siguiente"), { n: 1, unidad: "meses" });
assert.equal(duracionEnTexto("10 días para A y 20 días para B"), null, "varias duraciones: ambiguo");

// Fechas escritas
assert.deepEqual(fechasEnTexto("Hasta: 30 de noviembre de 2026.", "2026-10-01"), ["2026-11-30"]);
assert.deepEqual(fechasEnTexto("31 de decembro", "2026-10-01"), ["2026-12-31"]); // gallego, sin año
assert.deepEqual(fechasEnTexto("Hasta las 14:00h del 30 octubre 2026", "2026-10-01"), ["2026-10-30"]);
assert.deepEqual(fechasEnTexto("A) Hasta 28/2/27 B) Hasta 30/4/27", "2026-10-01"), ["2027-02-28", "2027-04-30"]);

// Vencimientos (comprobados con calendario):
// Publicado el viernes 2026-10-09; 10 hábiles desde el sábado 10. Lunes 12 es festivo nacional:
// 13,14,15,16 (4) · 19..23 (9) · 26 (10) → lunes 2026-10-26.
assert.equal(await vencimiento("2026-10-09", { n: 10, unidad: "habiles" }, nacional), "2026-10-26");
// 15 naturales desde el 2026-10-16 → 2026-10-31 (sábado) → siguiente hábil: lunes 2 (el 1 es festivo y domingo).
assert.equal(await vencimiento("2026-10-16", { n: 15, unidad: "naturales" }, nacional), "2026-11-02");
// Un mes desde el 2026-01-31 → 28 de febrero (sábado) → lunes 2 de marzo.
assert.equal(await vencimiento("2026-01-31", { n: 1, unidad: "meses" }, nacional), "2026-03-02");

// Interpretación completa
const base = {
  tipo_convocatoria: "Concurrencia competitiva - canónica",
  fecha_inicio: null,
  fecha_fin: null,
  fecha_registro: "2026-10-01",
  publicacion: null,
};
// Instrumental: registro de una concesión directa; sus fechas son de ejecución, no de solicitud.
let i = await interpretarPlazo(
  { ...base, tipo_convocatoria: "Concesión directa - instrumental", fecha_inicio: "2026-01-01", fecha_fin: "2026-12-31", texto_inicio: null, texto_fin: null },
  nacional,
);
assert.equal(i.tipo, "sin_plazo", "instrumental");
let p = await interpretarPlazo({ ...base, texto_inicio: "SIN PLAZO DE SOLICITUD", texto_fin: "SIN PLAZO DE SOLICITUD" }, nacional);
assert.equal(p.tipo, "sin_plazo");
p = await interpretarPlazo({ ...base, texto_inicio: "Sense termini de presentació de sol·licitud", texto_fin: "Sense termini de presentació de sol·licitud" }, nacional);
assert.equal(p.tipo, "sin_plazo", "catalán");
// Caso real (BDNS 934991): BOP de Jaén del jueves 15-oct-2026, 20 días hábiles → 12-nov-2026.
p = await interpretarPlazo({ ...base, texto_inicio: "Día siguiente de la publicación del extracto en el BOP", texto_fin: "20 días hábiles a partir publicación del extracto en el BOP", publicacion: { fecha: "2026-10-15", diario: "B.O.P. DE JAÉN" } }, nacional);
assert.equal(p.fin, "2026-11-12");
p = await interpretarPlazo({ ...base, texto_inicio: "Día siguiente a la publicación del extracto", texto_fin: "Finaliza el 16 de noviembre de 2026" }, nacional);
assert.equal(p.tipo, "fechas"); assert.equal(p.fin, "2026-11-16");
p = await interpretarPlazo({ ...base, texto_inicio: "Desde la Publicación", texto_fin: "10 DÍAS HÁBILES" }, nacional);
assert.equal(p.tipo, "pendiente_publicacion");
p = await interpretarPlazo({ ...base, texto_inicio: "Desde la Publicación", texto_fin: "10 DÍAS HÁBILES", publicacion: { fecha: "2026-10-09", diario: "B.O.P. DE GIRONA" } }, nacional);
assert.equal(p.tipo, "calculado"); assert.equal(p.inicio, "2026-10-13"); assert.equal(p.fin, "2026-10-26");
p = await interpretarPlazo({ ...base, texto_inicio: "a partir del quinto día hábil de la publicación", texto_fin: "20 días hábiles", publicacion: { fecha: "2026-10-09", diario: "X" } }, nacional);
assert.equal(p.tipo, "desconocido", "inicio no estándar: no se calcula");

console.log("Plazos: OK");
