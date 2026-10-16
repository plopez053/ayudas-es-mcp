// Sincronización del espejo local de la BDNS.
//
//   1. Listado masivo del periodo → tabla convocatorias.
//   2. Un listado filtrado por cada finalidad, beneficiario, instrumento y comunidad → etiquetas.
//      Así cada convocatoria queda clasificada sin pedir su detalle (~50 peticiones en total).
//   3. Relleno del detalle (fechas, presupuesto...) de una en una, a ritmo lento.

import { BdnsNoDisponible, consultasDeEtiquetas, listar } from "./bdns.js";
import {
  escribirMeta,
  guardarEtiquetas,
  guardarListado,
  leerMeta,
  pendientesDeDetalle,
  soltarCerrojo,
  tomarCerrojo,
} from "./db.js";
import { actualizarPlazosGuardados, obtenerDetalle } from "./detalle.js";
import { hoy as hoyEspana } from "./fechas.js";
import { recalcularSeries } from "./series.js";

type Log = (msg: string) => void;
const DIA = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Tramos de como mucho un año: la API devuelve ~70.000 filas/año sin problema. */
function tramos(desde: string, hasta: string): [string, string][] {
  const out: [string, string][] = [];
  let a = new Date(desde + "T00:00:00Z");
  const fin = new Date(hasta + "T00:00:00Z");
  while (a <= fin) {
    const b = new Date(Math.min(a.getTime() + 365 * DIA, fin.getTime()));
    out.push([iso(a), iso(b)]);
    a = new Date(b.getTime() + DIA);
  }
  return out;
}

let enCurso: Promise<void> | undefined;

/**
 * Sincroniza convocatorias y etiquetas registradas entre `desde` y hoy.
 * Sin `desde`: desde 3 días antes de la última sincronización (las convocatorias pueden
 * registrarse con retraso), o los últimos `diasIniciales` días si la base está vacía.
 */
export function sincronizar(opts: { desde?: string; diasIniciales?: number; log?: Log } = {}) {
  enCurso ??= ejecutarSync(opts).finally(() => (enCurso = undefined));
  return enCurso;
}

async function ejecutarSync({ desde, diasIniciales = 365, log = () => {} }: {
  desde?: string;
  diasIniciales?: number;
  log?: Log;
}) {
  const hoy = hoyEspana();
  const ultima = leerMeta("ultima_sync");
  const inicio =
    desde ??
    (ultima
      ? iso(new Date(new Date(ultima).getTime() - 3 * DIA))
      : iso(new Date(Date.now() - diasIniciales * DIA)));

  const t0 = Date.now();
  for (const [a, b] of tramos(inicio, hoy)) {
    const filas = await listar({}, a, b);
    guardarListado(filas);
    log(`listado ${a} → ${b}: ${filas.length} convocatorias`);

    let n = 0;
    for await (const { tipo, valor, filtros } of consultasDeEtiquetas()) {
      const codigos = (await listar(filtros, a, b)).map((f) => f.codigo);
      guardarEtiquetas(codigos, tipo, valor);
      n++;
      if (n % 10 === 0) log(`  etiquetas: ${n} consultas`);
    }
    log(`  etiquetas: ${n} consultas hechas`);
  }

  const ventanaDesde = leerMeta("ventana_desde");
  if (!ventanaDesde || inicio < ventanaDesde) escribirMeta("ventana_desde", inicio);
  escribirMeta("ventana_hasta", hoy);
  escribirMeta("ultima_sync", new Date().toISOString());
  const s = recalcularSeries();
  log(`series recurrentes: ${s.series} (${s.convocatorias} convocatorias)`);
  log(`sincronización completa en ${Math.round((Date.now() - t0) / 1000)} s`);
}

/**
 * Pide el detalle de las convocatorias que no lo tienen (las más recientes primero) y vuelve
 * a pedirlo para las recientes sin fecha de fin, cuyo plazo puede concretarse después.
 * Se detiene si la BDNS empieza a bloquear.
 */
export async function rellenarDetalles(max: number, log: Log = () => {}): Promise<number> {
  const reinterpretados = await actualizarPlazosGuardados();
  if (reinterpretados) log(`plazos reinterpretados con las reglas nuevas: ${reinterpretados}`);
  let hechos = 0;
  for (const codigo of pendientesDeDetalle(max)) {
    try {
      await obtenerDetalle(codigo);
      hechos++;
      if (hechos % 50 === 0) log(`detalles: ${hechos}`);
    } catch (e) {
      if (e instanceof BdnsNoDisponible) {
        log(`detalles: la BDNS está limitando peticiones; se para tras ${hechos}`);
        break;
      }
      log(`detalles: ${codigo} falló (${(e as Error).message})`);
    }
  }
  return hechos;
}

/** ¿Hace falta sincronizar? (base vacía o última sincronización hace más de `horas`). */
export function necesitaSync(horas: number): boolean {
  const ultima = leerMeta("ultima_sync");
  return !ultima || Date.now() - new Date(ultima).getTime() > horas * 3_600_000;
}

/**
 * Detalles pedidos en cada ronda de mantenimiento (cada 6 h): a 1 petición/s son unos 8 minutos
 * de tráfico lento, compatible con el límite de la BDNS.
 */
const DETALLES_POR_RONDA = 500;

/** El calendario necesita varios años completos: se amplía hasta aquí en segundo plano. */
export const HISTORICO_DESDE = "2021-01-01";

/**
 * Mantenimiento completo de la base, con cerrojo entre procesos:
 * sincroniza si hace falta, amplía el histórico y rellena detalles.
 * Devuelve false si otra instancia ya lo está haciendo.
 */
export async function mantener(
  opts: { desde?: string; detalles?: number; forzar?: boolean; log?: Log } = {},
): Promise<boolean> {
  const log = opts.log ?? (() => {});
  if (!tomarCerrojo("mantenimiento", 45)) {
    log("otra instancia está sincronizando la base; se omite");
    return false;
  }
  try {
    if (opts.forzar || opts.desde || necesitaSync(6)) await sincronizar({ desde: opts.desde, log });
    // Primera ejecución: lo reciente ya está (rápido); el histórico se completa después.
    const desde = leerMeta("ventana_desde");
    if (!opts.desde && desde && desde > HISTORICO_DESDE) {
      log(`ampliando el histórico hasta ${HISTORICO_DESDE} (necesario para el calendario previsto)`);
      await sincronizar({ desde: HISTORICO_DESDE, log });
    }
    await rellenarDetalles(opts.detalles ?? DETALLES_POR_RONDA, log);
    return true;
  } finally {
    soltarCerrojo("mantenimiento");
  }
}
