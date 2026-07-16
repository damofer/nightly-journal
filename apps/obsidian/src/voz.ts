// Cliente del sidecar de voz (Whisper STT + Kokoro TTS + extracción de PDF)
// para el plugin: todo por requestUrl (sin CORS) y con arranque automático
// opcional del sidecar vía child_process (solo escritorio).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { requestUrl } from 'obsidian';

export interface VozKokoro {
  id: string;
  nombre: string;
  genero: 'f' | 'm';
  idioma: 'es' | 'en';
}

export interface SaludVoz {
  stt: boolean;
  kokoro: boolean;
  apagado?: boolean;
  voces_kokoro?: VozKokoro[];
  voz_defecto?: Record<string, string>;
}

export interface AjustesVoz {
  activada: boolean;
  url: string;
  // arranque automático (avanzado): si python y script existen, el plugin
  // levanta el sidecar solo, igual que hace el servidor web
  python: string;
  script: string;
  cwd: string;
}

export class ClienteVoz {
  private proceso: ChildProcess | null = null;
  private intentoArranque = false;

  constructor(private ajustes: AjustesVoz) {}

  async salud(): Promise<SaludVoz> {
    if (!this.ajustes.activada) return { stt: false, kokoro: false, apagado: true };
    try {
      const res = await requestUrl({ url: `${this.ajustes.url}/salud`, throw: false });
      if (res.status !== 200) return { stt: false, kokoro: false, apagado: true };
      return res.json as SaludVoz;
    } catch {
      return { stt: false, kokoro: false, apagado: true };
    }
  }

  // Levanta el sidecar si no responde y hay rutas configuradas. Una sola
  // vez por sesión de plugin: si el usuario lo mata, no insistimos.
  async asegurarSidecar(): Promise<void> {
    if (!this.ajustes.activada || this.intentoArranque) return;
    const salud = await this.salud();
    if (!salud.apagado) return;
    this.intentoArranque = true;
    const { python, script, cwd } = this.ajustes;
    if (!python || !script || !existsSync(python) || !existsSync(script)) return;
    try {
      const puerto = new URL(this.ajustes.url).port || '8765';
      this.proceso = spawn(python, [script, puerto], {
        cwd: cwd || undefined,
        stdio: 'ignore',
        detached: false,
      });
      this.proceso.on('error', () => {
        this.proceso = null;
      });
    } catch {
      this.proceso = null;
    }
  }

  apagar(): void {
    if (this.proceso && !this.proceso.killed) this.proceso.kill();
    this.proceso = null;
  }

  async tts(texto: string, voz: string | null, idioma: string): Promise<ArrayBuffer | null> {
    try {
      const res = await requestUrl({
        url: `${this.ajustes.url}/tts`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ texto, voz: voz ?? undefined, idioma }),
        throw: false,
      });
      return res.status === 200 ? res.arrayBuffer : null;
    } catch {
      return null;
    }
  }

  async stt(audio: ArrayBuffer, tipo: string, idioma: string): Promise<string | null> {
    try {
      const res = await requestUrl({
        url: `${this.ajustes.url}/stt?idioma=${idioma}`,
        method: 'POST',
        contentType: tipo,
        body: audio,
        throw: false,
      });
      if (res.status !== 200) return null;
      const datos = res.json as { texto?: string };
      return datos.texto ?? null;
    } catch {
      return null;
    }
  }

  async extraerPdf(datos: ArrayBuffer): Promise<string | undefined> {
    try {
      const res = await requestUrl({
        url: `${this.ajustes.url}/extraer`,
        method: 'POST',
        contentType: 'application/pdf',
        body: datos,
        throw: false,
      });
      if (res.status !== 200) return undefined;
      return (res.json as { texto?: string }).texto;
    } catch {
      return undefined;
    }
  }
}
