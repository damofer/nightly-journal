// Transporte HTTP del plugin: requestUrl de Obsidian en vez de fetch —
// el fetch del renderer (origen app://obsidian.md) es bloqueado por CORS
// contra localhost; requestUrl viaja por el proceso principal y no tiene
// CORS. Ojo: requestUrl LANZA en status >= 400 salvo que se pase
// throw: false, y no soporta abort (el timeout se emula con Promise.race).

import { requestUrl } from 'obsidian';
import type { FnHttpJson } from '../../diario/src/red.js';

function plazo(ms: number): Promise<never> {
  return new Promise((_, rechazar) => {
    window.setTimeout(() => rechazar(new Error(`timeout tras ${ms}ms`)), ms);
  });
}

export const transporteRequestUrl: FnHttpJson = async (url, cuerpo, opciones) => {
  const peticion = requestUrl({
    url,
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify(cuerpo),
    throw: false,
  });
  const res = opciones?.timeoutMs ? await Promise.race([peticion, plazo(opciones.timeoutMs)]) : await peticion;
  return { status: res.status, texto: res.text };
};

// Modelos ya descargados en Ollama, para ofrecerlos en el primer arranque
// (la app de Ollama ya no lista modelos viejos en su UI y mandar al usuario
// final a la terminal mata el arranque).
export async function listarModelos(url: string): Promise<string[]> {
  try {
    const res = await requestUrl({ url: `${url}/api/tags`, throw: false });
    if (res.status !== 200) return [];
    const datos = res.json as { models?: { name: string }[] };
    return (datos.models ?? []).map(m => m.name);
  } catch {
    return [];
  }
}

// Pide a Ollama descargar un modelo. Con stream:false la petición queda
// abierta hasta el final (sin progreso — requestUrl no streamea); el caller
// sondea /api/tags para saber cuándo llegó.
export async function descargarModelo(url: string, modelo: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await requestUrl({
      url: `${url}/api/pull`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ model: modelo, stream: false }),
      throw: false,
    });
    return res.status === 200 ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Puerto del /api/estado del servidor web: ¿Ollama responde? ¿está el modelo?
export async function estadoOllama(url: string, modelo: string): Promise<{ ollama: boolean; modeloOk: boolean }> {
  try {
    const res = await requestUrl({ url: `${url}/api/tags`, throw: false });
    if (res.status !== 200) return { ollama: false, modeloOk: false };
    const datos = res.json as { models?: { name: string }[] };
    const modelos = (datos.models ?? []).map(m => m.name);
    const modeloOk = modelos.some(m => m === modelo || m.startsWith(`${modelo}:`));
    return { ollama: true, modeloOk };
  } catch {
    return { ollama: false, modeloOk: false };
  }
}
