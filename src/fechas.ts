// Fechas de calendario (YYYY-MM-DD) en hora peninsular española.
//
// Los plazos y el BOE van por días de calendario en España: con la fecha UTC, entre las 00:00
// y las 02:00 de la madrugada "hoy" sería todavía ayer y un plazo vencido saldría como abierto.

const FORMATO = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid" }); // sv-SE = YYYY-MM-DD

/** Fecha de hoy en España. */
export const hoy = (): string => FORMATO.format(new Date());

export const sumarDias = (iso: string, n: number): string =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** Fecha de hace `n` días (o dentro de `-n` días) en España. */
export const haceDias = (n: number): string => sumarDias(hoy(), -n);
