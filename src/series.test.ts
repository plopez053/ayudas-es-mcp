// Pruebas sin red de la confianza de las series del calendario.
import assert from "node:assert/strict";
import { confianzaDe } from "./series.js";

const dias = (xs: [number, number][]) => new Map(xs);

// Cinco años en la misma semana: alta.
assert.equal(confianzaDe(dias([[2021, 280], [2022, 283], [2023, 279], [2024, 285], [2025, 281]]), 281, 2, 2026), "alta");

// Tres años: como mucho media aunque sean muy regulares.
assert.equal(confianzaDe(dias([[2023, 280], [2024, 283], [2025, 281]]), 281, 2, 2026), "media");

// Un año sin convocar en medio: como mucho media.
assert.equal(confianzaDe(dias([[2021, 280], [2022, 283], [2023, 279], [2025, 281]]), 281, 2, 2026), "media");

// El año pasado se movió dos meses (la mediana de la variación no lo refleja): baja un nivel.
assert.equal(confianzaDe(dias([[2023, 284], [2024, 287], [2025, 224]]), 284, 3, 2026), "baja");

// Fechas muy irregulares: baja.
assert.equal(confianzaDe(dias([[2022, 30], [2023, 120], [2024, 200], [2025, 90]]), 90, 60, 2026), "baja");

// Los años iguales o posteriores al de la previsión no cuentan.
assert.equal(confianzaDe(dias([[2022, 280], [2023, 283], [2024, 279], [2025, 281], [2026, 100]]), 281, 2, 2026), "alta");

console.log("Series: OK");
