// Peticiones HTTP con tiempo máximo: sin él, una conexión que se queda colgada bloquea la
// herramienta indefinidamente.

const TIMEOUT_MS = Number(process.env.AYUDAS_TIMEOUT_MS ?? 30_000);

export const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch con tiempo máximo. Los fallos de red y los timeouts se lanzan como ErrorDeRed. */
export async function pedir(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const causa = (e as Error).name === "TimeoutError" ? `sin respuesta en ${timeoutMs / 1000} s` : (e as Error).message;
    throw new ErrorDeRed(`${new URL(url).host}: ${causa}`);
  }
}

export class ErrorDeRed extends Error {}

/**
 * Para servicios sin bloqueo por ráfagas (BOE, festivos): reintenta los fallos de red y los
 * errores 5xx/429, que suelen ser momentáneos. Devuelve la última respuesta si no se recupera.
 */
export async function pedirConReintentos(url: string, init: RequestInit = {}, intentos = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const res = await pedir(url, init);
      if ((res.status < 500 && res.status !== 429) || i + 1 >= intentos) return res;
    } catch (e) {
      if (!(e instanceof ErrorDeRed) || i + 1 >= intentos) throw e;
    }
    await esperar(1000 * 2 ** i);
  }
}
