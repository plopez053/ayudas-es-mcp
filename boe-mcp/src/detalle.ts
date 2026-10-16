// Detalle de una convocatoria: se pide a la BDNS, se interpreta su plazo y se guarda.

import { cargarDetalle, type AyudaDetalle } from "./bdns.js";
import { comunidadUnica, detallesGuardados, escribirMeta, guardarDetalle, leerMeta } from "./db.js";
import { festivosDe, interpretarPlazo, VERSION_PLAZOS, type Plazo } from "./plazos.js";

export interface DetalleCompleto extends AyudaDetalle {
  plazo_interpretado: Plazo;
}

async function plazoDe(d: AyudaDetalle): Promise<Plazo> {
  try {
    return await interpretarPlazo(
      {
        tipo_convocatoria: d.tipo,
        fecha_inicio: d.fecha_inicio,
        fecha_fin: d.fecha_fin,
        texto_inicio: d.texto_inicio,
        texto_fin: d.texto_fin,
        fecha_registro: d.fecha_registro,
        publicacion: d.publicaciones[0] ?? null,
      },
      // Festivos de la comunidad si la convocatoria es de una sola; si no, solo los nacionales.
      festivosDe(comunidadUnica(d.codigo)),
    );
  } catch (e) {
    // Sin calendario de festivos no se calcula: mejor "consultar" que una fecha errónea.
    return {
      tipo: "desconocido",
      inicio: d.fecha_inicio,
      fin: d.fecha_fin,
      explicacion: `No se pudo calcular el plazo (${(e as Error).message}).`,
    };
  }
}

export async function obtenerDetalle(codigo: string): Promise<DetalleCompleto> {
  const d = await cargarDetalle(codigo);
  const completo = { ...d, plazo_interpretado: await plazoDe(d) };
  guardarDetalle(completo);
  return completo;
}

/**
 * Si las reglas de plazos han cambiado (VERSION_PLAZOS), reinterpreta los detalles guardados
 * con los datos que ya tienen, sin volver a pedirlos a la BDNS.
 */
export async function actualizarPlazosGuardados(): Promise<number> {
  if (leerMeta("version_plazos") === String(VERSION_PLAZOS)) return 0;
  let n = 0;
  for (const d of detallesGuardados()) {
    guardarDetalle({ ...d, plazo_interpretado: await plazoDe(d) }, false);
    n++;
  }
  escribirMeta("version_plazos", String(VERSION_PLAZOS));
  return n;
}
