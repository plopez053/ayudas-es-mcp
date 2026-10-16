// Pruebas de la lectura de documentos, con textos sintéticos que reproducen los fallos reales
// que se encontraron al probar con convocatorias de la BDNS.
import assert from "node:assert/strict";
import {
  buscarPalabras,
  buscarTema,
  importesEnTexto,
  limpiarPaginas,
  ordenarDocumentos,
  pareceTitulo,
  puntuarDocumento,
  tituloDe,
} from "./documentos.js";

// --- Elección del documento ------------------------------------------------------------------
const orden = ordenarDocumentos([
  { id: "1", nombre: "Anexo I solicitud" },
  { id: "2", nombre: "Documento de la convocatoria en español" },
  { id: "3", nombre: "TEXTO INTEGRO DE LA CONVOCATORIA" },
  { id: "4", nombre: "Convocatòria en català" },
  { id: "5", nombre: "Declaración de ingresos" },
]).map((d) => d.id);
assert.deepEqual(orden.slice(0, 2), ["3", "2"], "el texto íntegro va antes que el acuerdo de aprobación");
assert.ok(puntuarDocumento("Modelo de solicitud") < 0, "un formulario no es la convocatoria");
assert.ok(puntuarDocumento("Texto en castellano de la convocatoria") > puntuarDocumento("Texto en euskera de la convocatoria"));

// --- Títulos -------------------------------------------------------------------------------
// Fallo real: el título se cortaba en el punto de «15.000 €», convirtiendo una frase en «título».
assert.equal(
  tituloDe("5. En el caso de importes subvencionables de bienes igual o superiores a 15.000 € o de obras"),
  "En el caso de importes subvencionables de bienes igual o superiores a 15.000 € o de obras",
);
assert.equal(tituloDe("Artículo 5. Cuantía de la subvención."), "Cuantía de la subvención");
assert.equal(tituloDe("BASE TERCERA. CUANTÍA DE LAS AYUDAS"), "CUANTÍA DE LAS AYUDAS");
assert.equal(tituloDe("Undécimo.- Criterios de valoración técnica (hasta 50 puntos)"), "Criterios de valoración técnica (hasta 50 puntos)");
// Fallo real: primera línea de una frase partida por el ancho de página.
assert.ok(!pareceTitulo("Las subvenciones se otorgarán mediante el prorrateo entre los beneficiarios de la"));
assert.ok(!pareceTitulo("En el caso de importes subvencionables (IVA excluido) de bienes"));
assert.ok(!pareceTitulo("Los requisitos deberán concurrir en la fecha de finalización del plazo"));
assert.ok(pareceTitulo("Plazo y forma de presentación de solicitudes"));
assert.ok(pareceTitulo("CUANTÍA DE LAS AYUDAS E IMPUTACIÓN PRESUPUESTARIA"));

// --- Limpieza -------------------------------------------------------------------------------
const pie = "Para validar este documento acceda a https://sede.ejemplo.es CSV 123";
const limpias = limpiarPaginas([
  `${pie}\nRESOLUCIÓN DE LA CONVO-\nCATORIA\nPágina 1 de 4`,
  `${pie}\nTexto de la segunda página\nPágina 2 de 4`,
  `${pie}\nTexto de la tercera\nPágina 3 de 4`,
  `${pie}\nTexto de la cuarta\nPágina 4 de 4`,
]);
assert.ok(limpias[0].includes("CONVOCATORIA"), "une las palabras partidas por guion");
assert.ok(!limpias.some((p) => p.includes("Para validar")), "quita la cabecera repetida en cada página");
assert.ok(!limpias.some((p) => /Página \d de 4/.test(p)), "quita «Página N de M»");

// --- Apartados ------------------------------------------------------------------------------
// Estructura de bases con numeración que se reinicia en los subapartados (fallo real: «6. Plazo»
// salía vacío porque «1.» se confundía con el siguiente apartado).
const bases = limpiarPaginas([
  [
    "3. Sujetos beneficiarios",
    "Podrán acceder a las ayudas las empresas mercantiles y las personas empresarias",
    "individuales con domicilio fiscal en el municipio.",
    "4. Requisitos",
    "Las personas participantes deberán cumplir los siguientes requisitos:",
    "1. Estar legalmente constituidas conforme a su naturaleza jurídica.",
    "2. Estar al corriente de sus obligaciones tributarias.",
  ].join("\n"),
  [
    "5. Cuantía",
    "La dotación será de 550.000 € y la ayuda máxima por solicitante de 15.000 €.",
    "6. Plazo y forma de presentación de solicitudes",
    "1. El plazo de presentación de solicitudes será de un mes, contado desde el día siguiente",
    "a la publicación del extracto en el Boletín Oficial de la Provincia.",
    "2. La solicitud se presentará por medios electrónicos en la sede electrónica.",
    "7. Instrucción del procedimiento",
    "El órgano instructor realizará de oficio las actuaciones necesarias.",
  ].join("\n"),
]);

const plazo = buscarTema(bases, "plazo", 800, 1)[0];
assert.ok(plazo, "localiza el plazo");
assert.equal(plazo.tipo, "apartado");
assert.match(plazo.texto, /será de un mes/);
assert.match(plazo.texto, /sede electrónica/, "incluye los subapartados 1. y 2.");
assert.doesNotMatch(plazo.texto, /Instrucción del procedimiento/, "se detiene en el apartado 7");
assert.equal(plazo.paginas[0], 2);

const cuantia = buscarTema(bases, "cuantia", 800, 1)[0];
assert.match(cuantia.texto, /550\.000 €/);

const benef = buscarTema(bases, "beneficiarios", 800, 1)[0];
assert.equal(benef.tipo, "apartado");
assert.match(benef.titulo, /Sujetos beneficiarios/);

const requisitos = buscarTema(bases, "requisitos", 800, 1)[0];
assert.match(requisitos.texto, /Estar al corriente de sus obligaciones/);

// Un tema que no está no debe inventarse: sin apartado de criterios, devuelve vacío.
assert.equal(buscarTema(bases, "criterios", 800, 1).length, 0);

// «Destinatarios de los datos» (protección de datos) no es el apartado de beneficiarios.
const rgpd = limpiarPaginas(["5. Destinatarios de los datos\nSe comunicarán los datos a las instituciones de origen del solicitante y a los juzgados."]);
assert.equal(buscarTema(rgpd, "beneficiarios", 500, 1).length, 0);

// --- Búsqueda de palabras e importes --------------------------------------------------------
const hall = buscarPalabras(bases, ["tributarias"]);
assert.equal(hall.length, 1);
assert.equal(hall[0].pagina, 1);
assert.equal(buscarPalabras(bases, ["inexistente"]).length, 0);

const imp = importesEnTexto(bases);
assert.deepEqual(
  imp.map((i) => i.importe),
  ["550.000 €", "15.000 €"],
);
assert.equal(imp[0].pagina, 2);

console.log("Documentos: OK");
