# ayudas-es-mcp

Guía de uso del servidor MCP de ayudas y subvenciones de España.

Permite que una IA consulte dos fuentes oficiales, sin claves ni scraping:

- **BDNS (infosubvenciones.es):** convocatorias de ayudas y subvenciones de todas las
  administraciones: Estado, comunidades, diputaciones y ayuntamientos.
- **BOE (datos abiertos):** normativa, oposiciones y licitaciones.

Las consultas se hacen en directo. No hay que descargar ni sincronizar ninguna base de datos:
se instala y funciona.

## Qué aporta

Sobre la API de la BDNS, el servidor añade:

- Recuentos exactos, no estimados sobre una muestra.
- Plazos de solicitud calculados a partir del texto de cada convocatoria.
- Separación de las ayudas que realmente se pueden pedir.
- Lectura de las bases en PDF, con el número de página de cada cita.
- Un calendario previsto de las convocatorias que se repiten cada año.
- Avisos explícitos cuando no sabe algo, en lugar de callarlo.

## 1. Requisitos

- Node.js 22.13 o superior.
- Un cliente compatible con MCP (Claude Code, Claude Desktop, Cursor u otro).

No hace falta instalar nada más ni configurar claves.

## 2. Instalación

### Claude Code

```bash
claude mcp add ayudas -- npx -y ayudas-es-mcp
```

### Claude Desktop, Cursor y otros clientes

Añade este bloque a la configuración MCP del cliente y reinícialo:

```json
{
  "mcpServers": {
    "ayudas": {
      "command": "npx",
      "args": ["-y", "ayudas-es-mcp"]
    }
  }
}
```

## 3. Comprobar que funciona

En una terminal:

```bash
npx ayudas-es-mcp --version
```

En el cliente, pregunta por ejemplo: «¿Qué ayudas abiertas hay para autónomos en Galicia para
digitalización?». Si el servidor está activo, la IA usará las herramientas `ayudas_*`.

## 4. Qué se le puede preguntar

- «¿Qué ayudas para pymes del País Vasco suelen salir en los próximos dos meses?»
- «¿Hay alguna ayuda que salga todos los años por estas fechas y este año aún no haya salido?»
- «¿Qué comunidad ha convocado más ayudas de vivienda este año?»
- «¿Cuántas ayudas para pymes se han convocado cada mes desde mayo?»
- «Hazme el resumen semanal para una pyme de hostelería en Andalucía.»
- «¿Ha salido alguna oposición de enfermería en el BOE este mes?»

Hay además dos prompts, que los clientes muestran como comandos (`/`):

| Prompt | Para qué sirve |
|---|---|
| `ayudas_para_mi` | Parte de un perfil («autónoma, peluquería en Bilbao») y devuelve en una tabla las ayudas abiertas, las que suelen salir pronto y los requisitos de las mejores. |
| `analizar_convocatoria` | Ficha de una convocatoria a partir de su código: plazo, cuantía, requisitos y documentación, citando página. |

## 5. Herramientas

Todas son de solo lectura (anotación MCP), por lo que los clientes que lo admiten no piden
confirmación en cada llamada. Los valores de las listas cerradas (comunidad, beneficiario,
finalidad…) admiten mayúsculas, tildes y nombres habituales: «País Vasco», «Euskadi» o «pymes»
valen igual que `pais-vasco` o `autonomo-o-pyme`.

| Herramienta | Función |
|---|---|
| `ayudas_buscar` | Busca por texto, comunidad, beneficiario, finalidad, instrumento y administración. Da el total exacto y una muestra con estado, plazo y presupuesto. |
| `ayudas_recuento` | Recuentos y rankings exactos por comunidad, finalidad, beneficiario, instrumento, administración, órgano, mes o año. |
| `ayudas_previstas` | Calendario previsto: ayudas que se convocan cada año y que, según su histórico desde 2021, saldrán pronto o se están retrasando. |
| `ayuda_detalle` | Ficha completa: plazo interpretado, extracto oficial, bases, documentos e historial. |
| `ayuda_texto` | Lee el PDF de las bases y devuelve el texto literal de sus apartados, con página. |
| `novedades_perfil` | Boletín para un perfil: ayudas nuevas sin cerrar y BOE sobre sus temas, sin convenios ni planes de estudios. Si un tema no da resultados, lo vuelve a buscar por prefijo y lo indica. |
| `estado_datos` | Origen de los datos, estado de la caché y del calendario. |
| `boe_sumario_dia` | Publicaciones del BOE de un día, filtrables por palabras y sección. |
| `boe_buscar` | Búsqueda en el BOE por rango de fechas, palabras y sección (`2B` oposiciones, `5A` licitaciones). |
| `boe_documento` | Texto de una disposición del BOE. |

El servidor envía además instrucciones al modelo: qué herramienta usar para contar o para leer
requisitos, y que cite códigos y avisos en lugar de completar con datos inventados.

## 6. Configuración

```bash
npx ayudas-es-mcp --help
npx ayudas-es-mcp --version
npx ayudas-es-mcp --vaciar-cache
```

Variables de entorno opcionales:

| Variable | Qué controla | Por defecto |
|---|---|---|
| `AYUDAS_CACHE` | Ruta del archivo de caché | `~/.cache/ayudas-es-mcp/cache.sqlite` |
| `BDNS_INTERVALO_MS` | Pausa entre peticiones a la BDNS | 1000 |
| `AYUDAS_TIMEOUT_MS` | Tiempo máximo por petición | 30000 |

### Caché

Las respuestas se guardan en disco (o solo en memoria si no se puede escribir) para no repetir
peticiones. No es una copia de la BDNS: solo guarda lo ya consultado. La duración depende de
cuánto puede cambiar cada dato:

| Dato | Se guarda |
|---|---|
| Totales y listados de un periodo cerrado hace más de 7 días | 1 semana |
| Totales y listados que incluyen días recientes | 1 hora |
| Ficha con plazo provisional (extracto sin publicar) | 1 día |
| Ficha de una convocatoria cerrada o sin solicitud | 1 mes |
| Otras fichas | 1 semana |
| Texto extraído de un PDF | 1 mes |
| Calendario previsto | 1 semana |

## 7. Cómo funciona

Cada pregunta se traduce en consultas a la
[API oficial de la BDNS](https://www.infosubvenciones.es/bdnstrans/doc/swagger):

- **Totales exactos con una sola petición.** La API devuelve cuántas coincidencias tiene una
  búsqueda sin descargarla. Un recuento simple cuesta una petición y un ranking, una por grupo.
- **Búsqueda por palabras en dos pasos.** La API busca subcadenas («tala» encontraría
  «instalación»). Se le envía la raíz de cada palabra y sobre su respuesta se aplican las reglas
  de palabra descritas más abajo.
- **Detalle solo de lo que se muestra.** Plazo, presupuesto y tipo están en la ficha de cada
  convocatoria, que se pide únicamente al enseñarla.
- **Ritmo prudente.** Como máximo una petición por segundo a la BDNS, que bloquea las ráfagas.

### Búsqueda por palabras

Se busca en el título (y en el título cooficial en euskera, catalán o gallego), sin tildes, con
límite de palabra, singular y plural equivalentes («pyme» y «pymes») y prefijo con `*`
(«digital*» encuentra digitalización y digitales). No es una búsqueda semántica: «digitalización»
no encuentra «transformación tecnológica». Para temas amplios conviene usar `finalidad`.

### Plazo de cada convocatoria

La BDNS solo trae fechas de solicitud en una parte de las convocatorias. En el resto el plazo
viene en texto y se interpreta con reglas, sin IA:

| El texto dice | Resultado |
|---|---|
| Tipo «Concesión directa - instrumental» | No se puede solicitar: es el registro de una ayuda ya concedida a un beneficiario concreto. |
| «Hasta el 30 de noviembre de 2026», «31 de decembro», «1/3/27» | Abierta o cerrada según la fecha (castellano, gallego y catalán). |
| «10 días hábiles desde el día siguiente a la publicación», con el extracto ya publicado | Fecha de fin calculada con el calendario. |
| Lo mismo, con el extracto sin publicar | Pendiente de publicar. |
| «Sin plazo de solicitud», «no procede», «nominativa» | No se puede solicitar. |
| Varios plazos o inicio no estándar | Consultar: no se arriesga una fecha. |

El cálculo sigue la Ley 39/2015, art. 30: días hábiles sin sábados, domingos ni festivos; los
meses acaban el mismo día del mes de vencimiento; si el último día es inhábil, pasa al siguiente
hábil. Los festivos nacionales y autonómicos vienen de [Nager.Date](https://date.nager.at). Los
locales no se incluyen, y por eso la respuesta indica siempre que es un cálculo y cómo se hizo.
Los casos comprobados a mano están en `src/plazos.test.ts`.

### Lectura de las bases (PDF)

`ayuda_texto` descarga el PDF de la convocatoria y devuelve texto literal con página, sin
resumir ni usar IA. Solo se hace bajo demanda y cada documento se procesa una vez.

- Elige el documento por su nombre: prefiere «texto íntegro» o «bases» a un anexo, un formulario
  o un acuerdo de aprobación. Si el elegido no se puede leer, pasa al siguiente y lo dice. La
  respuesta lista los demás para poder pedirlos (`documento`).
- Localiza apartados por su título (Artículo, Base, «Primero.-», «6. Plazo…», mayúsculas).
  Distingue apartado (hay un título que corresponde) de mención (solo se nombra el tema).
- Con `buscar` y `paginas` se puede ir directamente a una palabra o a unas páginas cuando los
  apartados no se reconocen.
- Extrae las cantidades en euros, cada una con la frase en la que aparece.
- El contenido del PDF se entrega marcado como texto literal de un documento externo, no como
  instrucciones.

Límites: no hay OCR (los PDF escaneados sin capa de texto no se leen), no se leen documentos
Word u otros formatos, y de los archivos de más de 25 MB o 200 páginas solo se leen las
primeras. Los apartados se detectan con reglas, así que conviene comprobar la página citada.

### Calendario previsto

Se agrupan las convocatorias del mismo órgano con el mismo título sin años, fechas ni ediciones
(«XIV Premios X 2026» equivale a «XV Premios X 2027»). Las convocadas en tres o más años forman
una serie con su fecha típica de registro y su variación. Se excluyen las nominativas, las
directas y los convenios, que no se pueden solicitar.

Cada serie lleva una confianza (alta, media o baja) según los años que se ha convocado y lo
regular que es su fecha. Baja un nivel si el año pasado se registró lejos de su fecha habitual,
y no pasa de media si algún año no se convocó. La baja se oculta por defecto. Algunas series cambian de nombre o dejan
de convocarse, así que la fecha prevista es una estimación. La herramienta calcula la evaluación
con cada calendario y la muestra, para que la IA pueda decir cuánto fiarse.

El calendario necesita el histórico desde 2021. Se prepara en segundo plano la primera vez que se
usa una herramienta de ayudas, no al arrancar, y entretanto `ayudas_previstas` avisa de que se
está preparando en lugar de responder «no hay».

## 8. Cómo se evita dar información errónea

| Riesgo | Qué se hace |
|---|---|
| Decir «no hay ayudas» cuando solo la búsqueda no encontró | La respuesta vacía lo advierte: la búsqueda es por palabras del título y no prueba que no existan. |
| Contar sobre una muestra | `ayudas_buscar` da el total exacto y marca la lista como muestra; para contar está `ayudas_recuento`. |
| Mezclar ayudas estatales con las de una comunidad | Cada ficha indica su ámbito, y las de toda España se marcan como «ESTATAL» aunque las convoque un organismo de otra comunidad. |
| Ayudas que ya no se pueden pedir | Distingue cerradas, sin solicitud (concesión directa) y abiertas, y separa las instrumentales. |
| Sumar presupuestos parciales | La BDNS no da el presupuesto en bloque, así que los recuentos no lo suman; el de cada convocatoria está en su ficha. |
| Mirar solo los últimos 90 días sin decirlo | Lo indica y cuenta cuántas más hay registradas antes con los mismos filtros. |
| Descargar miles de filas para una pregunta | Si excluir concesiones directas exige descargar más de 30.000 filas, pide acotar. |
| «Hoy» equivocado de madrugada | Las fechas van en hora peninsular española, no en UTC. |
| Una fuente lenta o caída | Cada petición tiene tiempo máximo y reintentos, también si la respuesta se corta a medias; un fallo puntual no tumba la respuesta, se avisa de lo que falta. |
| Calendario aún sin preparar | Dice que se está preparando, en vez de «0 ayudas recurrentes». |
| Calendario sobre series con varias ayudas al año | Marca las series en las que el órgano registra varias con el mismo título. |
| Citar de un PDF algo que no está | Devuelve texto literal con página, distingue apartado de mención y avisa si no localiza un tema. |
| Texto de un PDF con instrucciones | Se entrega marcado como dato literal de un documento externo. |
| Código que no existe | Error inmediato y claro, sin reintentos. |

## 9. Limitaciones conocidas

- **Estado de las ayudas.** La BDNS no indica si una convocatoria está abierta (su campo
  `abierto` viene siempre a `false` y sus filtros de abierta y tipo se ignoran en silencio), así
  que se deduce del plazo interpretado. Los plazos calculados no incluyen festivos locales.
- **Concesiones directas.** Solo se sabe con seguridad cuáles son con el detalle de cada
  convocatoria. En búsquedas y recuentos, el filtro `excluir_directas` las estima por el título,
  por lo que no las detecta todas. Los recuentos sin ese filtro las incluyen y lo advierten.
- **Presupuestos y ayudas antiguas.** El presupuesto y el plazo solo constan en la ficha de cada
  convocatoria, así que los recuentos no suman presupuestos y la búsqueda no localiza ayudas
  registradas hace meses que sigan abiertas (avisa de cuántas hay antes del periodo).
- **Rankings la primera vez.** Agrupar por comunidad o finalidad cuesta una petición por grupo y
  puede tardar; repetido, sale de la caché.
- **Calendario.** Predice el registro en la BDNS, no el plazo de solicitud, y no detecta una
  ayuda que cambie de nombre.
- **Comunidad.** Una parte de las convocatorias no tiene comunidad autónoma asignada en la BDNS.
- **Mismo título, distintas ayudas.** Hay órganos que registran decenas de ayudas individuales
  bajo un mismo título; no son duplicados, así que no se eliminan.
- **Lectura de PDF.** Sin OCR y por reglas, no por IA.
- **Varias instancias.** El límite de una petición por segundo es por proceso: varios clientes
  abiertos a la vez suman su ritmo, aunque comparten la caché en disco.

## 10. Desarrollo

```bash
git clone … && cd ayudas-es-mcp
npm install
npm run build
npm test            # pruebas sin red: plazos, lectura de documentos, fechas, caché
npm run test:live   # búsqueda en directo frente a la referencia + prueba de extremo a extremo
```

## Datos y licencia

El código se distribuye con licencia MIT (ver [LICENSE](LICENSE)).

- **BDNS.** Origen de los datos: Intervención General de la Administración del Estado. Se
  reutilizan según su [aviso legal](https://www.infosubvenciones.es/bdnstrans/GE/es/avisolegal),
  que permite el uso comercial y no comercial citando la fuente y sin desnaturalizar la
  información. Este servidor solo consulta convocatorias, no datos personales de beneficiarios.
- **BOE.** Origen de los datos: [Agencia Estatal Boletín Oficial del Estado](https://www.boe.es),
  mediante su API de datos abiertos. Se reutilizan según su
  [aviso legal](https://www.boe.es/informacion/aviso_legal/index.php), que permite el uso
  comercial y no comercial citando la fuente, con enlace a boe.es, y sin sugerir su respaldo.
- **Festivos.** [Nager.Date](https://date.nager.at), API pública de festivos.

Proyecto independiente: no está afiliado a la IGAE, a la Agencia Estatal BOE ni a ningún
organismo público, ni cuenta con su respaldo. La información puede cambiar o corregirse en la
fuente: compruébala siempre en la ficha oficial antes de presentar una solicitud.
