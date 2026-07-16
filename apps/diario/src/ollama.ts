import type { Config } from './config.js';
import { postJson } from './red.js';

export interface Mensaje {
  role: 'system' | 'user' | 'assistant';
  content: string;
  // imágenes en base64 — gemma3 es multimodal, Ollama las acepta por mensaje
  images?: string[];
}

// Los modelos razonadores devuelven bloques <think> que no van al usuario ni al vault.
function limpiarRazonamiento(texto: string): string {
  return texto.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function llamar(cfg: Config, modelo: string, mensajes: Mensaje[], extra: Record<string, unknown>): Promise<string> {
  const cuerpo: Record<string, unknown> = { model: modelo, messages: mensajes, stream: false, ...extra };
  if (/qwen3|deepseek-r1/.test(modelo)) cuerpo.think = false;
  let res: { status: number; texto: string };
  try {
    res = await postJson(`${cfg.ollamaUrl}/api/chat`, cuerpo);
  } catch {
    throw new Error(`No pude conectar con Ollama en ${cfg.ollamaUrl}. ¿Está corriendo? (abre Ollama o corre "ollama serve")`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`Ollama respondió ${res.status}: ${res.texto}`);
  const datos = JSON.parse(res.texto) as { message?: { content?: string } };
  return limpiarRazonamiento(datos.message?.content ?? '');
}

export function conversar(cfg: Config, mensajes: Mensaje[], opciones?: { temperature?: number }): Promise<string> {
  return llamar(cfg, cfg.modelo, mensajes, { options: { temperature: opciones?.temperature ?? 0.7 } });
}

export async function extraerEstructurado<T>(cfg: Config, mensajes: Mensaje[], esquema: unknown): Promise<T> {
  const texto = await llamar(cfg, cfg.modeloExtractor, mensajes, { format: esquema, options: { temperature: 0 } });
  return JSON.parse(texto) as T;
}
