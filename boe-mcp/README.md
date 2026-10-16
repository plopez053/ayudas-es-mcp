# ayudas-es-mcp

Servidor MCP que da a una IA acceso a dos fuentes oficiales españolas, sin scraping ni claves:

- **BDNS / infosubvenciones.es**: convocatorias de ayudas y subvenciones de *todas* las
  administraciones (Estado, comunidades, diputaciones y ayuntamientos), en una **base local**
  que se sincroniza sola.
- **BOE** (API de datos abiertos): normativa, oposiciones, licitaciones.

Lo que lo distingue de consultar la API en directo: **recuentos exactos**, **plazos calculados**,
**separación de las ayudas que de verdad se pueden pedir** y un **calendario previsto** de las
convocatorias que se repiten cada año. Y avisa de lo que no sabe en lugar de callarlo.

## Instalación

Requiere Node.js 22.13 o superior. No hay que instalar nada más: la primera vez descarga y
prepara los datos solo (~2 min lo reciente; el histórico para el calendario, ~10 min más en
segundo plano).

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

Mientras la base se construye por primera vez, las herramientas responden con un error claro
(«aún se está construyendo») en lugar de decir que no hay ayudas.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `ayudas_buscar` | Ayudas por texto, comunidad, beneficiario (autónomo/pyme, particular…), finalidad, instrumento y administración. Total exacto + muestra con estado, plazo y presupuesto. |
| `ayudas_recuento` | Recuentos y rankings exactos por comunidad, finalidad, beneficiario, instrumento, administración, órgano, mes o año. |
| `ayudas_previstas` | **Calendario previsto**: ayudas que se convocan cada año y que, por su histórico desde 2021, saldrán en los próximos días, o que este año se están retrasando. Con su fiabilidad medida. |
| `ayuda_detalle` | Ficha completa: plazo interpretado, extracto oficial (requisitos, cuantía, cómo pedirla), bases, documentos e historial si se convoca cada año. |
| `ayuda_texto` | **Lee el PDF de las bases**: devuelve el texto literal de sus apartados (cuantía, plazo, beneficiarios, requisitos, documentación, criterios…) con el número de página; o las páginas o palabras que se pidan. |
| `novedades_perfil` | Boletín para un perfil: ayudas nuevas sin cerrar + BOE sobre sus temas. |
| `estado_datos` | Qué periodo cubre la base, cuántas convocatorias tienen detalle y cuándo se sincronizó. |
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

## Cómo se evita dar información errónea

Una herramienta que se equivoca con seguridad es peor que ninguna. Por eso:

| Riesgo | Qué se hace |
|---|---|
| Decir «no hay ayudas» cuando solo la búsqueda no encontró | La respuesta vacía lo advierte: la búsqueda es por palabras del título y no prueba que no existan |
| Contar sobre una muestra | `ayudas_buscar` da el **total exacto** y marca la lista como muestra; para contar hay `ayudas_recuento` |
| Datos viejos | Avisa si la última sincronización tiene más de 48 h; los plazos provisionales se vuelven a pedir si tienen más de un día |
| Ayudas que ya no se pueden pedir | Distingue cerradas, sin solicitud (concesión directa) y abiertas; las instrumentales (72 % de lo reciente) se separan |
| Sumar presupuestos con datos parciales | El presupuesto solo se muestra si hay dato del 80 % de las convocatorias |
| Mirar solo los últimos 90 días sin decirlo | Lo indica, cuenta cuántas más hay registradas antes y muestra aparte las antiguas con plazo conocido aún abierto |
| «Hoy» equivocado de madrugada | Las fechas (plazos, BOE de hoy) van en hora peninsular española, no en UTC |
| Una fuente lenta o caída | Cada petición tiene tiempo máximo y reintentos; un fallo puntual no tumba la respuesta entera, se avisa de lo que falta |
| Calendario con histórico insuficiente | Se niega a responder hasta tener 3 años completos, en vez de decir «0 ayudas recurrentes» |
| Calendario sobre ayudas que no son una sola | Marca las series en las que el órgano registra varias al año con el mismo título |
| Base vacía en el primer arranque | Error explícito, no un resultado vacío |
| Citar de un PDF algo que no está | Devuelve texto literal con página, distingue apartado de mención y avisa si no localiza un tema en lugar de inventarlo |
| Texto de un PDF con instrucciones | Se entrega marcado como dato literal de un documento externo |
| Código que no existe | Error inmediato y claro, no un reintento de 30 s |

### Rendimiento

Todo sale de una base local; las consultas típicas tardan entre 50 y 500 ms (el peor caso, un
recuento por comunidad sobre las 378.000 convocatorias, ~2 s). La lectura de PDF solo ocurre al
pedirla (~1 s la primera vez, milisegundos después) y su librería se carga en ese momento, no
al arrancar. La sincronización no descarga documentos.

### Verificado contra la fuente

`npm run test:live` compara los recuentos de la base local con los de la API oficial **en directo**, con
filtros simples y combinados (finalidad + beneficiario + comunidad…). Resultado: coinciden
exactamente en los 7 casos, sobre ~70.000 convocatorias.

## Lectura de las bases (PDF)

`ayuda_texto` descarga el PDF de la convocatoria y devuelve **texto literal con página**, sin
resumir ni usar IA. Solo se hace bajo demanda (nunca en la sincronización) y el texto se guarda
en la base: cada documento se descarga y procesa una sola vez.

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
Los festivos nacionales y autonómicos vienen de [Nager.Date](https://date.nager.at); los
**locales no se incluyen**, por eso la respuesta dice siempre que es un cálculo y cómo se ha hecho.
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
título (otras cambian de nombre o dejan de convocarse). La herramienta recalcula y muestra
esta evaluación en cada sincronización, para que la IA pueda decir cuánto fiarse.

## Cómo funciona la base local

Consultar la BDNS en cada pregunta no escala: el detalle de cada convocatoria cuesta una
petición y la API bloquea las ráfagas. En cambio, su listado masivo es barato y admite los
mismos filtros que el buscador. Por eso:

1. **Listado**: todas las convocatorias del periodo → SQLite (`~/.boe-mcp/bdns.sqlite`),
   paginando de 10.000 en 10.000 (es el máximo de la API).
2. **Clasificación**: un listado filtrado por cada finalidad, beneficiario, instrumento y
   comunidad (~50 peticiones) etiqueta cada convocatoria sin pedir su detalle.
3. **Detalle** (fechas, presupuesto…): se rellena a 1 petición/segundo (500 por ronda), primero
   las que se pueden solicitar y de las más recientes a las más antiguas (las que el título
   delata como concesión directa, al final: su detalle casi nunca cambia nada). Además se pide
   al momento para lo que se muestra en una respuesta.

El servidor sincroniza al arrancar si han pasado más de 6 horas y cada 6 horas mientras está
abierto. Varios clientes pueden compartir la misma base: un cerrojo evita que sincronicen a la
vez y dupliquen las peticiones. También se puede lanzar a mano o programar:

```bash
npx ayudas-es-mcp sync                         # incremental
npx ayudas-es-mcp sync --desde 2021-01-01      # histórico completo
npx ayudas-es-mcp sync --detalles 1000         # rellenar más detalles (por defecto 500)
npx ayudas-es-mcp --help
```

Variables: `BOE_MCP_DB` (ruta de la base), `BDNS_INTERVALO_MS` (ritmo de peticiones, 1000 por
defecto) y `AYUDAS_TIMEOUT_MS` (tiempo máximo por petición, 30000 por defecto).

## Desarrollo

```bash
git clone … && cd boe-mcp
npm install
npm run build
npm run sync        # primera carga
npm test            # pruebas sin red: plazos, lectura de documentos, fechas
npm run test:live   # verificación contra la API oficial + prueba de extremo a extremo
```

## Búsqueda por palabras

Sobre el título (y el título cooficial en euskera, catalán o gallego), sin tildes, con límite
de palabra («tala» no coincide con «instalación»), singular/plural («pyme» ↔ «pymes») y
prefijo con `*` («digital*» → digitalización, digitales). No es semántica: «digitalización»
no encuentra «transformación tecnológica»; para temas amplios conviene usar `finalidad`.

## Limitaciones conocidas

- **Estado de las ayudas.** La BDNS no indica si una convocatoria está abierta (su campo
  `abierto` viene siempre a `false` y sus filtros de abierta/tipo se ignoran en silencio): se
  deduce del plazo interpretado. Los plazos calculados no incluyen festivos locales.
- **Concesiones directas.** Solo se sabe con seguridad cuáles son con el detalle de cada
  convocatoria. Sin él, el filtro `excluir_directas` las estima por el título: precisión ~97 %,
  detecta ~67 %. Los recuentos sin ese filtro las incluyen y lo advierten.
- **Presupuesto y plazo de las antiguas.** Solo constan en el detalle, que se descarga poco a
  poco (de lo reciente a lo antiguo). En los recuentos el presupuesto se muestra únicamente
  cuando hay dato del 80 % de las convocatorias, y una ayuda de hace meses solo aparece como
  «todavía abierta» si ya se conoce su plazo.
- **El calendario predice el registro en la BDNS**, no el plazo de solicitud, y no detecta una
  ayuda que cambie de nombre. Acierta a ±15 días en el 35-51 % de los casos (ver arriba).
- **Comunidad.** ~2 % de las convocatorias no tienen comunidad autónoma asignada en la BDNS.
- **Mismo título, distintas ayudas.** Hay órganos que registran decenas de ayudas
  individuales bajo un mismo título; no son duplicados, así que no se eliminan. Los recuentos
  dan también los «títulos distintos».
- **Festivos locales.** Cada municipio tiene dos y no existe una fuente abierta única; por eso
  los plazos calculados los ignoran y lo advierten.
- **Lectura de PDF.** Sin OCR (los escaneados no se leen) y por reglas, no por IA: ver arriba.
- **Reutilización de datos.** BOE y BDNS son datos abiertos, pero la BDNS tiene su propio
  [aviso legal](https://www.infosubvenciones.es/bdnstrans/GE/es/avisolegal). Cita la fuente.
