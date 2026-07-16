// Transporte HTTP inyectable: la app y el CLI usan fetch, pero dentro de
// Obsidian el fetch del renderer es bloqueado por CORS contra localhost —
// el plugin inyecta un transporte basado en requestUrl (sin CORS).

export interface RespuestaHttp {
  status: number;
  texto: string;
}

export type FnHttpJson = (url: string, cuerpo: unknown, opciones?: { timeoutMs?: number }) => Promise<RespuestaHttp>;

const porFetch: FnHttpJson = async (url, cuerpo, opciones) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: opciones?.timeoutMs ? AbortSignal.timeout(opciones.timeoutMs) : undefined,
  });
  return { status: res.status, texto: await res.text() };
};

let transporte: FnHttpJson = porFetch;

export function fijarTransporte(fn?: FnHttpJson): void {
  transporte = fn ?? porFetch;
}

export const postJson: FnHttpJson = (url, cuerpo, opciones) => transporte(url, cuerpo, opciones);
