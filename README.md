# ayudas-es-mcp

Servidor MCP que da a una IA acceso a dos fuentes oficiales españolas, sin scraping ni claves:

- **BDNS / infosubvenciones.es**: convocatorias de ayudas y subvenciones de *todas* las
  administraciones (Estado, comunidades, diputaciones y ayuntamientos).
- **BOE** (API de datos abiertos): normativa, oposiciones, licitaciones.

Se consultan **en directo**: no hay base de datos que descargar ni sincronizar, así que funciona
al instalarlo y los datos están siempre al día. Lo que añade a la API: **recuentos exactos**,
**plazos calculados**, **separación de las ayudas que de verdad se pueden pedir**, **lectura de las
bases en PDF** y un **calendario previsto** de las convocatorias que se repiten cada año. Y avisa
de lo que no sabe en lugar de callarlo.

## Instalación

Requiere Node.js 22.13 o superior. No hay que instalar ni configurar nada más.

### Claude Code

```bash
claude mcp add ayudas -- npx -y ayudas-es-mcp
```

### Claude Desktop, Cursor y otros clientes

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

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `ayudas_buscar` | Ayudas por texto, comunidad, beneficiario (autónomo/pyme, particular…), finalidad, instrumento y administración. Total exacto + muestra con estado, plazo y presupuesto. |
| `ayudas_recuento` | Recuentos y rankings exactos por comunidad, finalidad, beneficiario, instrumento, administración, órgano, mes o año. |
| `ayudas_previstas` | **Calendario previsto**: ayudas que se convocan cada año y que, por su histórico desde 2021, saldrán en los próximos días, o que este año se están retrasando. Con su fiabilidad medida. |
| `ayuda_detalle` | Ficha completa: plazo interpretado, extracto oficial (requisitos, cuantía, cómo pedirla), bases, documentos e historial si se convoca cada año. |
| `ayuda_texto` | **Lee el PDF de las bases**: devuelve el texto literal de sus apartados (cuantía, plazo, beneficiarios, requisitos, documentación, criterios…) con el número de página; o las páginas o palabras que se pidan. |
| `novedades_perfil` | Boletín para un perfil: ayudas nuevas sin cerrar + BOE sobre sus temas. |
| `estado_datos` | De dónde salen los datos, estado de la caché y del calendario. |
| `boe_sumario_dia` | Publicaciones del BOE de un día, filtrables por palabras y sección. |
| `boe_buscar` | Búsqueda en el BOE en un rango de fechas por palabras y/o sección (`2B` oposiciones, `5A` licitaciones). |
| `boe_documento` | Texto de una disposición del BOE. |

Todas están marcadas como **de solo lectura** (anotaciones MCP), así que los clientes que lo
admiten no piden confirmación en cada llamada. El servidor envía además unas **instrucciones**
al modelo: qué herramienta usar para contar o para leer requisitos, y que cite el código y los
avisos en lugar de completar con datos inventados.

### Prompts

| Prompt | Qué hace |
|---|---|
| `ayudas_para_mi` | A partir de un perfil («autónoma, peluquería en Bilbao»): ayudas abiertas, las que suelen salir pronto y la cuantía y requisitos de las mejores, en una tabla. |
| `analizar_convocatoria` | Ficha de una convocatoria por su código: plazo, cuantía, requisitos y documentación, citando página. |

En Claude Desktop y Claude Code aparecen como comandos (`/`).

## Ejemplos de preguntas

- «¿Qué ayudas abiertas hay para autónomos en Galicia para digitalización?»
- «¿Qué ayudas para pymes del País Vasco suelen salir en los próximos dos meses?»
- «¿Hay alguna ayuda que salga todos los años por estas fechas y este año aún no haya salido?»
- «¿Qué comunidad ha convocado más ayudas de vivienda este año?»
- «¿Cuántas ayudas para pymes se han convocado cada mes desde mayo?»
- «Hazme el resumen semanal para una pyme de hostelería en Andalucía.»
- «¿Ha salido alguna oposición de enfermería en el BOE este mes?»

## Cómo funciona

Cada pregunta se traduce a consultas a la [API oficial de la BDNS](https://www.infosubvenciones.es/bdnstrans/doc/swagger):

- **Totales exactos con una sola petición.** La API devuelve el número de coincidencias de una
  búsqueda sin descargarla; un recuento simple cuesta una petición, y un ranking, una por grupo.
- **Búsqueda por palabras en dos pasos.** La API busca subcadenas («tala» encuentra
  «instalación»). Se le envía la raíz de cada palabra y sobre lo que devuelve se aplican las
  reglas de palabra (ver abajo). Comprobado: da exactamente lo mismo que descargar todo el
  listado y filtrarlo (8 de 8 casos, incluidos prefijos, siglas y títulos en euskera).
- **Detalle solo de lo que se muestra**: plazo, presupuesto y tipo están en la ficha de cada
  convocatoria, que se pide al enseñarla.
- **Ritmo prudente**: como mucho una petición por segundo a la BDNS, que bloquea las ráfagas.

### Caché temporal

Las respuestas se guardan en `~/.cache/ayudas-es-mcp/cache.sqlite` (o solo en memoria si no se
puede escribir), con una caducidad según lo que puede cambiar:

| Dato | Se guarda |
|---|---|
| Totales y listados de un periodo que acabó hace más de 7 días | 1 semana |
| Totales y listados que incluyen días recientes | 1 hora |
| Ficha con plazo provisional (pendiente de publicar el extracto) | 1 día |
| Ficha de una convocatoria cerrada o sin solicitud | 1 mes |
| Otras fichas | 1 semana |
| Texto extraído de un PDF | 1 mes |
| Calendario previsto (solo las series calculadas, no el histórico) | 1 semana |

No es una copia de la BDNS: solo guarda lo ya preguntado. Dos preguntas iguales a la vez
comparten la petición. `npx ayudas-es-mcp --vaciar-cache` la borra.

### Tiempos

Medidos con la caché vacía, a una petición por segundo:

| Consulta | Primera vez | Repetida |
|---|---|---|
| Buscar «digital*» para pymes, 3 abiertas | ~4 s | inmediata |
| Buscar en Galicia, 10 abiertas | ~12 s | ~1 s |
| Recuento por mes, pymes desde mayo | ~7 s | inmediata |
| Recuento por órgano de «euskera» en el País Vasco (todo el histórico) | ~2 s | inmediata |
| Ranking por comunidad, vivienda en 2026 | ~21 s | inmediata |
| Calendario previsto | 2-3 min, una vez por semana y en segundo plano | inmediata |

El calendario necesita el histórico desde 2021 (~40 peticiones): se prepara en segundo plano la
primera vez que se usa una herramienta de ayudas, no al arrancar, y entretanto
`ayudas_previstas` dice que se está preparando en lugar de responder «no hay».

## Cómo se evita dar información errónea

Una herramienta que se equivoca con seguridad es peor que ninguna. Por eso:

| Riesgo | Qué se hace |
|---|---|
| Decir «no hay ayudas» cuando solo la búsqueda no encontró | La respuesta vacía lo advierte: la búsqueda es por palabras del título y no prueba que no existan |
| Contar sobre una muestra | `ayudas_buscar` da el **total exacto** y marca la lista como muestra; para contar hay `ayudas_recuento` |
| Ayudas que ya no se pueden pedir | Distingue cerradas, sin solicitud (concesión directa) y abiertas; las instrumentales (72 % de lo reciente) se separan |
| Sumar presupuestos parciales | La BDNS no da el presupuesto en bloque, así que los recuentos no lo suman; el de cada convocatoria está en su ficha |
| Mirar solo los últimos 90 días sin decirlo | Lo indica y cuenta cuántas más hay registradas antes con los mismos filtros |
| Descargar miles de filas para una pregunta | Si excluir concesiones directas exige descargar más de 30.000 filas, pide acotar en vez de hacerlo |
| «Hoy» equivocado de madrugada | Las fechas (plazos, BOE de hoy) van en hora peninsular española, no en UTC |
| Una fuente lenta o caída | Cada petición tiene tiempo máximo y reintentos; un fallo puntual no tumba la respuesta entera, se avisa de lo que falta |
| Calendario aún sin preparar | Dice que se está preparando, en vez de «0 ayudas recurrentes» |
| Calendario sobre ayudas que no son una sola | Marca las series en las que el órgano registra varias al año con el mismo título |
| Citar de un PDF algo que no está | Devuelve texto literal con página, distingue apartado de mención y avisa si no localiza un tema en lugar de inventarlo |
| Texto de un PDF con instrucciones | Se entrega marcado como dato literal de un documento externo |
| Código que no existe | Error inmediato y claro, no un reintento de 30 s |

## Lectura de las bases (PDF)

`ayuda_texto` descarga el PDF de la convocatoria y devuelve **texto literal con página**, sin
resumir ni usar IA. Solo se hace bajo demanda y el texto se guarda en la caché: cada documento
se descarga y procesa una sola vez.

- **Elige el documento** por su nombre: prefiere «texto íntegro» o «bases» a un anexo,
  formulario o acuerdo de aprobación; si el elegido no deja localizar apartados, prueba con los
  siguientes más probables. Si el elegido no se puede leer (un Word, demasiado grande), pasa al
  siguiente y lo dice. La respuesta lista los demás para poder pedirlos (`documento`).
- **Localiza apartados por su título** (Artículo, Base, «Primero.-», «6. Plazo…», MAYÚSCULAS),
  descartando frases partidas por el ancho de página, la protección de datos y los anexos con
  formularios. Distingue **apartado** (hay un título que corresponde) de **mención** (solo se
  nombra el tema), y lo dice.
- **Con `buscar` y `paginas`** se puede ir directamente a una palabra o a unas páginas cuando
  los apartados no se reconocen.
- **Cantidades en euros** del documento, cada una con la frase en la que aparece.
- **El contenido del PDF se entrega como dato, no como instrucciones**: se marca como texto
  literal de un documento externo.

Probado con 15 convocatorias reales (ayuntamientos, diputaciones, universidades): localiza la
cuantía en 15, el plazo en 14, los beneficiarios en 14 y los requisitos en 14.

**Límites**: PDF escaneados sin capa de texto (se avisa; no hay OCR), documentos Word u otros
formatos, y archivos de más de 25 MB o 200 páginas (se leen las primeras). Los apartados se
detectan con reglas: comprueba siempre la página citada.

## Plazo real de cada convocatoria

La BDNS solo trae fechas de solicitud en una parte de las convocatorias. En el resto el plazo
viene en texto, y se interpreta de forma determinista (sin LLM):

| El texto dice | Resultado |
|---|---|
| Tipo «Concesión directa - **instrumental**» | ⚫ no se puede solicitar: es el registro de una ayuda ya concedida a un beneficiario concreto (sus fechas son de ejecución) |
| «Hasta el 30 de noviembre de 2026», «31 de decembro», «1/3/27» | 🟢/🔴 según la fecha (castellano, gallego y catalán) |
| «10 días hábiles desde el día siguiente a la publicación» y el extracto ya está publicado | 🟢 **fecha de fin calculada** con el calendario |
| Lo mismo, pero el extracto aún no se ha publicado | 🟡 pendiente de publicar |
| «Sin plazo de solicitud», «no procede», «nominativa»… | ⚫ no se puede solicitar |
| Varios plazos, inicio no estándar («a partir del quinto día hábil»…) | ⚪ consultar (no se arriesga una fecha) |

Medido sobre 1.004 convocatorias recientes con detalle: el 72 % son instrumentales (antes
aparecían como «abiertas» por tener fechas), y solo el 2 % queda como «consultar».

El cálculo sigue la Ley 39/2015, art. 30: días hábiles sin sábados, domingos ni festivos; meses
hasta el mismo día del mes de vencimiento; si el último día es inhábil, el siguiente hábil.
Los festivos nacionales y autonómicos vienen de [Nager.Date](https://date.nager.at) (los de la
comunidad cuando todas las regiones de la convocatoria son de una sola); los **locales no se
incluyen**, por eso la respuesta dice siempre que es un cálculo y cómo se ha hecho.
Pruebas con casos comprobados a mano en `src/plazos.test.ts`.

## Calendario previsto (ayudas recurrentes)

Se agrupan las convocatorias del mismo órgano con el mismo título sin años, fechas ni
ediciones («XIV Premios X 2026» ≈ «XV Premios X 2027»). Las convocadas en 3 o más años
forman una serie con su fecha típica de registro (mediana circular, para que 28-dic y 3-ene
estén cerca) y su variación. Se excluyen las nominativas, directas y convenios, que no se
pueden solicitar.

**Fiabilidad medida** (prever 2025 usando solo 2021-2024 y compararlo con lo ocurrido):

| Confianza | Error mediano | A ±15 días |
|---|---|---|
| Alta (4+ años, variación ≤ 15 días) | 15 días | 51 % |
| Media | 26 días | 35 % |
| Baja (oculta por defecto) | 55 días | 15 % |

Además, solo el 59 % de las series activas en 2024 volvió a convocarse en 2025 con el mismo
título (otras cambian de nombre o dejan de convocarse). La evaluación se recalcula con cada
calendario y la herramienta la muestra, para que la IA pueda decir cuánto fiarse.

## Búsqueda por palabras

Sobre el título (y el título cooficial en euskera, catalán o gallego), sin tildes, con límite
de palabra («tala» no coincide con «instalación»), singular/plural («pyme» ↔ «pymes») y
prefijo con `*` («digital*» → digitalización, digitales). No es semántica: «digitalización»
no encuentra «transformación tecnológica»; para temas amplios conviene usar `finalidad`.

## Opciones

```bash
npx ayudas-es-mcp --help
npx ayudas-es-mcp --vaciar-cache
npx ayudas-es-mcp --version
```

Variables: `AYUDAS_CACHE` (ruta de la caché), `BDNS_INTERVALO_MS` (ritmo de peticiones, 1000
por defecto) y `AYUDAS_TIMEOUT_MS` (tiempo máximo por petición, 30000 por defecto).

## Desarrollo

```bash
git clone … && cd ayudas-es-mcp
npm install
npm run build
npm test            # pruebas sin red: plazos, lectura de documentos, fechas, caché
npm run test:live   # búsqueda en directo frente a la referencia + prueba de extremo a extremo
```

## Limitaciones conocidas

- **Estado de las ayudas.** La BDNS no indica si una convocatoria está abierta (su campo
  `abierto` viene siempre a `false` y sus filtros de abierta/tipo se ignoran en silencio): se
  deduce del plazo interpretado. Los plazos calculados no incluyen festivos locales.
- **Concesiones directas.** Solo se sabe con seguridad cuáles son con el detalle de cada
  convocatoria. En búsquedas y recuentos, el filtro `excluir_directas` las estima por el título:
  precisión ~97 %, detecta ~67 %. Los recuentos sin ese filtro las incluyen y lo advierten.
  Excluirlas en periodos muy largos sin otros filtros exigiría descargar decenas de miles de
  filas, así que se pide acotar.
- **Presupuestos y ayudas antiguas.** El presupuesto y el plazo solo constan en la ficha de cada
  convocatoria, así que los recuentos no suman presupuestos y la búsqueda no localiza ayudas
  registradas hace meses que sigan abiertas (avisa de cuántas hay antes del periodo).
- **Rankings la primera vez.** Agrupar por comunidad o finalidad cuesta una petición por grupo
  (~20 s); repetido, sale de la caché.
- **El calendario predice el registro en la BDNS**, no el plazo de solicitud, y no detecta una
  ayuda que cambie de nombre. Acierta a ±15 días en el 35-51 % de los casos (ver arriba).
- **Comunidad.** ~2 % de las convocatorias no tienen comunidad autónoma asignada en la BDNS.
- **Mismo título, distintas ayudas.** Hay órganos que registran decenas de ayudas
  individuales bajo un mismo título; no son duplicados, así que no se eliminan. Cuando se
  descargan las filas, los recuentos dan también los «títulos distintos».
- **Lectura de PDF.** Sin OCR (los escaneados no se leen) y por reglas, no por IA: ver arriba.
- **Varias instancias.** El límite de una petición por segundo es por proceso: varios clientes
  abiertos a la vez suman su ritmo (comparten, eso sí, la caché en disco).

## Datos y licencia

- **BDNS.** Origen de los datos: Intervención General de la Administración del Estado. Se
  reutilizan según su [aviso legal](https://www.infosubvenciones.es/bdnstrans/GE/es/avisolegal),
  que permite el uso comercial y no comercial citando la fuente y sin desnaturalizar la
  información. Este servidor solo consulta convocatorias, no datos personales de beneficiarios.
- **BOE.** API de datos abiertos de la Agencia Estatal Boletín Oficial del Estado.
- **Festivos.** [Nager.Date](https://date.nager.at).

Proyecto independiente: no está afiliado a la IGAE, a la Agencia Estatal BOE ni a ningún
organismo público, ni cuenta con su respaldo. La información puede cambiar o corregirse en la
fuente: compruébala siempre en la ficha oficial antes de presentar una solicitud.
