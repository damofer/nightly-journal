import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sea from 'node:sea';
import type { Idioma } from './idioma.js';

export interface ConfigVoz {
  activada: boolean;
  url: string;
  python: string;
  script: string;
  cwd: string;
  puerto: number;
  autoIniciar: boolean;
}

export interface Config {
  vault: string;
  ollamaUrl: string;
  modelo: string;
  modeloExtractor: string;
  // modelo de embeddings para la memoria de largo plazo (RAG)
  modeloEmbed?: string;
  preguntasMax: number;
  idioma?: Idioma;
  // auto-commit git del vault (default true; el plugin de Obsidian lo apaga)
  git?: boolean;
  ui?: { puerto?: number };
  voz?: ConfigVoz;
}

// ¿Corremos como ejecutable único (Node SEA)? En ese caso no existe la
// estructura del repo: el config vive junto al .exe y el HTML va embebido.
export const esStandalone = sea.isSea();

export function htmlEmbebido(): string | null {
  return esStandalone ? sea.getAsset('index.html', 'utf8') : null;
}

// En el bundle CJS del standalone import.meta.url no existe: se cae al
// directorio del ejecutable, que es justo lo que queremos allí.
export const raizApp = (() => {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return dirname(process.execPath);
  }
})();

export function rutaConfig(): string {
  return esStandalone ? join(dirname(process.execPath), 'config.json') : resolve(raizApp, 'config.json');
}

// Config por defecto del standalone (primera ejecución): vault en la
// carpeta del usuario y voz solo si chatterbox está instalado donde
// siempre. Se escribe junto al exe para que el usuario pueda editarlo.
function configDefecto(): Config {
  const cfg: Config = {
    vault: join(homedir(), 'DiarioVault'),
    ollamaUrl: 'http://localhost:11434',
    modelo: 'gemma3:4b',
    modeloExtractor: 'gemma3:4b',
    modeloEmbed: 'embeddinggemma',
    preguntasMax: 4,
    idioma: 'es',
    ui: { puerto: 4242 },
  };
  const pythonChatterbox = 'C:/Projects/chatterbox/chatterbox/.venv/Scripts/python.exe';
  const scriptVoz = 'C:/Projects/parallelme/apps/voz/servidor_voz.py';
  if (existsSync(pythonChatterbox) && existsSync(scriptVoz)) {
    cfg.voz = {
      activada: true,
      url: 'http://127.0.0.1:8765',
      python: pythonChatterbox,
      script: scriptVoz,
      cwd: 'C:/Projects/chatterbox/chatterbox',
      puerto: 8765,
      autoIniciar: true,
    };
  }
  return cfg;
}

export function cargarConfig(): Config {
  const ruta = rutaConfig();
  if (esStandalone && !existsSync(ruta)) {
    writeFileSync(ruta, `${JSON.stringify(configDefecto(), null, 2)}\n`, 'utf8');
  }
  const cfg = JSON.parse(readFileSync(ruta, 'utf8')) as Config;
  return {
    ...cfg,
    idioma: cfg.idioma ?? 'es',
    modeloEmbed: cfg.modeloEmbed ?? 'embeddinggemma',
    vault: resolve(raizApp, cfg.vault),
  };
}

// Persiste solo el campo idioma sin tocar el resto del config.json
// (respeta rutas relativas y cualquier edición manual del usuario).
export function guardarIdioma(idioma: Idioma): void {
  const ruta = rutaConfig();
  if (!existsSync(ruta)) return;
  const crudo = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>;
  crudo.idioma = idioma;
  writeFileSync(ruta, `${JSON.stringify(crudo, null, 2)}\n`, 'utf8');
}
