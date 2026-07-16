// Asistente de voz: deja el sidecar local (Whisper + Kokoro) funcionando sin
// que el usuario toque una terminal. El plugin es desktop-only, así que puede
// detectar Python, crear un venv propio FUERA del vault (para no ensuciar la
// sincronización), instalar las dependencias probadas, escribir
// servidor_voz.py desde el propio bundle y arrancarlo — con pasos y log en
// vivo, y todo 100% local.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Modal, Notice, Setting, type App } from 'obsidian';
import servidorVozPy from '../../voz/servidor_voz.py';
import type DiarioPlugin from './main.js';

// Receta verificada de punta a punta en un venv limpio (Windows, Python
// 3.11): mismas versiones que el venv que lleva semanas en producción.
// torch en PyPI para Windows/macOS es la build de CPU (suficiente; con GPU
// el usuario avanzado puede reinstalar torch con CUDA en el mismo venv).
const DEPENDENCIAS = [
  'torch==2.10.0',
  'kokoro==0.9.4',
  'misaki[en,es]==0.9.4',
  'transformers==4.46.3',
  'fastapi==0.135.1',
  'uvicorn==0.42.0',
  'soundfile==0.13.1',
  'pymupdf==1.27.2',
  'imageio-ffmpeg',
];

// Python 3.10–3.12: el rango con ruedas publicadas para TODO el stack
// (spacy/blis para el G2P inglés aún no cubren 3.13+ de forma fiable).
const CANDIDATOS_PYTHON: [string, string[]][] =
  process.platform === 'win32'
    ? [
        ['py', ['-3.12']],
        ['py', ['-3.11']],
        ['py', ['-3.10']],
        ['python', []],
        ['python3', []],
      ]
    : [
        ['python3.12', []],
        ['python3.11', []],
        ['python3.10', []],
        ['python3', []],
        ['python', []],
      ];

const TEXTOS = {
  es: {
    titulo: 'Configurar la voz',
    intro1:
      'La voz funciona con un motor local (Whisper te escucha, Kokoro te habla) que corre en tu equipo: nada sale a internet.',
    intro2:
      'Este asistente lo instala solo. Necesita Python 3.10–3.12 y descarga ~3 GB una única vez (dependencias + modelos de voz). Deja esta ventana abierta hasta que termine.',
    yaLista: 'La voz ya está configurada y respondiendo ✓',
    btnInstalar: '⚙ instalar y configurar',
    btnCerrar: 'cerrar',
    btnReintentar: '↻ reintentar',
    btnPython: '⬇ descargar Python',
    pasoPython: 'buscar Python (3.10–3.12)',
    sinPython:
      'No encontré Python 3.10–3.12 en este equipo. Instálalo desde python.org (en Windows marca "Add python.exe to PATH") y pulsa reintentar.',
    pasoVenv: 'crear el entorno aislado (venv)',
    pasoDeps: 'instalar dependencias (~2 GB, solo la primera vez)',
    pasoScript: 'escribir el sidecar y guardar los ajustes',
    pasoArranque: 'arrancar y descargar los modelos de voz',
    descargandoModelos: 'servidor arriba — descargando modelos de voz (una sola vez, varios minutos)…',
    noArranco: 'el sidecar no llegó a arrancar: revisa el log',
    fallo: 'Algo falló — el log de arriba dice el porqué. Corrige y reintenta.',
    listo: 'Voz lista 🎤 — habla con tu diario',
  },
  en: {
    titulo: 'Set up voice',
    intro1:
      'Voice runs on a local engine (Whisper listens, Kokoro speaks) on your machine: nothing leaves your computer.',
    intro2:
      'This assistant installs everything for you. It needs Python 3.10–3.12 and downloads ~3 GB once (dependencies + voice models). Keep this window open until it finishes.',
    yaLista: 'Voice is already set up and responding ✓',
    btnInstalar: '⚙ install and set up',
    btnCerrar: 'close',
    btnReintentar: '↻ retry',
    btnPython: '⬇ download Python',
    pasoPython: 'find Python (3.10–3.12)',
    sinPython:
      'I couldn\'t find Python 3.10–3.12 on this machine. Install it from python.org (on Windows tick "Add python.exe to PATH") and hit retry.',
    pasoVenv: 'create the isolated environment (venv)',
    pasoDeps: 'install dependencies (~2 GB, first time only)',
    pasoScript: 'write the sidecar and save settings',
    pasoArranque: 'start it and download the voice models',
    descargandoModelos: 'server is up — downloading voice models (once, several minutes)…',
    noArranco: "the sidecar didn't start: check the log",
    fallo: 'Something failed — the log above says why. Fix it and retry.',
    listo: 'Voice ready 🎤 — talk to your journal',
  },
};

// Carpeta de datos del asistente, FUERA del vault: un venv dentro de
// .obsidian reventaría la sincronización del usuario.
export function dirVoz(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'nightly-journal', 'voz');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'nightly-journal', 'voz');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'nightly-journal', 'voz');
}

const espera = (ms: number) => new Promise<void>(listo => window.setTimeout(listo, ms));

export class AsistenteVoz extends Modal {
  private t: (typeof TEXTOS)['es'];
  private pasosEl!: HTMLElement;
  private logEl!: HTMLElement;
  private botonesEl!: HTMLElement;
  private lineas: string[] = [];
  private procesoActual: ChildProcess | null = null;
  private cancelado = false;

  constructor(
    app: App,
    private plugin: DiarioPlugin
  ) {
    super(app);
    this.t = TEXTOS[plugin.idioma()];
  }

  onOpen(): void {
    this.contentEl.addClass('diario-asistente-voz');
    this.titleEl.setText(this.t.titulo);
    this.contentEl.createDiv({ cls: 'diario-tarjeta-texto', text: this.t.intro1 });
    this.contentEl.createDiv({ cls: 'diario-tarjeta-texto', text: this.t.intro2 });
    this.pasosEl = this.contentEl.createDiv({ cls: 'diario-asistente-pasos' });
    this.logEl = this.contentEl.createEl('pre', { cls: 'diario-asistente-log' });
    this.logEl.hide();
    this.botonesEl = this.contentEl.createDiv();
    void this.pantallaInicial();
  }

  onClose(): void {
    this.cancelado = true;
    this.procesoActual?.kill();
    this.contentEl.empty();
  }

  private async pantallaInicial(): Promise<void> {
    // si el sidecar ya responde no hay nada que instalar
    const salud = await this.plugin.voz().salud();
    if (salud.stt && salud.kokoro) {
      this.pasosEl.createDiv({ text: this.t.yaLista });
      new Setting(this.botonesEl).addButton(b => b.setButtonText(this.t.btnCerrar).onClick(() => this.close()));
      return;
    }
    new Setting(this.botonesEl).addButton(b =>
      b
        .setButtonText(this.t.btnInstalar)
        .setCta()
        .onClick(() => void this.ejecutar())
    );
  }

  // ── pasos y log ───────────────────────────────────────────────

  private nuevoPaso(texto: string): HTMLElement {
    return this.pasosEl.createDiv({ text: `⏳ ${texto}` });
  }

  private cerrarPaso(paso: HTMLElement, ok: boolean): void {
    paso.setText(paso.getText().replace('⏳', ok ? '✓' : '✗'));
  }

  private log(linea: string): void {
    this.logEl.show();
    this.lineas.push(linea.trimEnd());
    if (this.lineas.length > 400) this.lineas.splice(0, this.lineas.length - 400);
    this.logEl.setText(this.lineas.slice(-14).join('\n'));
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // Corre un comando volcando stdout/err al log; resuelve con el exit code.
  private correr(cmd: string, args: string[]): Promise<number> {
    return new Promise(resolver => {
      const proceso = spawn(cmd, args, { windowsHide: true });
      this.procesoActual = proceso;
      const volcar = (trozo: Buffer) => {
        for (const linea of trozo.toString().split(/\r?\n|\r/)) if (linea.trim()) this.log(linea);
      };
      proceso.stdout?.on('data', volcar);
      proceso.stderr?.on('data', volcar);
      proceso.on('close', codigo => {
        this.procesoActual = null;
        resolver(codigo ?? 1);
      });
      proceso.on('error', e => {
        this.log(String(e));
        this.procesoActual = null;
        resolver(127);
      });
    });
  }

  // Versión de un candidato a Python ("Python 3.11.9") o null si no existe.
  private probarPython(cmd: string, args: string[]): Promise<string | null> {
    return new Promise(resolver => {
      let salida = '';
      let proceso: ChildProcess;
      try {
        proceso = spawn(cmd, [...args, '--version'], { windowsHide: true });
      } catch {
        resolver(null);
        return;
      }
      const plazo = window.setTimeout(() => proceso.kill(), 8000);
      proceso.stdout?.on('data', (b: Buffer) => (salida += b.toString()));
      proceso.stderr?.on('data', (b: Buffer) => (salida += b.toString()));
      proceso.on('close', codigo => {
        window.clearTimeout(plazo);
        resolver(codigo === 0 && salida.includes('Python 3.') ? salida.trim() : null);
      });
      proceso.on('error', () => {
        window.clearTimeout(plazo);
        resolver(null);
      });
    });
  }

  private async detectarPython(): Promise<{ cmd: string; args: string[]; version: string } | null> {
    for (const [cmd, args] of CANDIDATOS_PYTHON) {
      const version = await this.probarPython(cmd, args);
      const m = version?.match(/Python 3\.(\d+)\./);
      if (version && m && Number(m[1]) >= 10 && Number(m[1]) <= 12) return { cmd, args, version };
    }
    return null;
  }

  // ── pantallas de salida ───────────────────────────────────────

  private pantallaSinPython(): void {
    this.pasosEl.createDiv({ cls: 'diario-tarjeta-texto', text: this.t.sinPython });
    this.botonesEl.empty();
    new Setting(this.botonesEl)
      .addButton(b =>
        b
          .setButtonText(this.t.btnPython)
          .setCta()
          .onClick(() => window.open('https://www.python.org/downloads/'))
      )
      .addButton(b => b.setButtonText(this.t.btnReintentar).onClick(() => void this.ejecutar()));
  }

  private pantallaFallo(): void {
    this.pasosEl.createDiv({ cls: 'diario-tarjeta-texto', text: this.t.fallo });
    this.botonesEl.empty();
    new Setting(this.botonesEl)
      .addButton(b =>
        b
          .setButtonText(this.t.btnReintentar)
          .setCta()
          .onClick(() => void this.ejecutar())
      )
      .addButton(b => b.setButtonText(this.t.btnCerrar).onClick(() => this.close()));
  }

  // ── flujo principal (idempotente: reintentar re-entra sin romper) ──

  private async ejecutar(): Promise<void> {
    this.pasosEl.empty();
    this.botonesEl.empty();
    const t = this.t;

    // 1. Python
    const pasoPython = this.nuevoPaso(t.pasoPython);
    const python = await this.detectarPython();
    if (this.cancelado) return;
    if (!python) {
      this.cerrarPaso(pasoPython, false);
      this.pantallaSinPython();
      return;
    }
    this.log(`${python.version} · ${python.cmd} ${python.args.join(' ')}`.trim());
    this.cerrarPaso(pasoPython, true);

    // 2. venv propio en la carpeta de datos (idempotente)
    const dir = dirVoz();
    const venvPython =
      process.platform === 'win32' ? join(dir, 'venv', 'Scripts', 'python.exe') : join(dir, 'venv', 'bin', 'python');
    const pasoVenv = this.nuevoPaso(t.pasoVenv);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(venvPython)) {
      const codigo = await this.correr(python.cmd, [...python.args, '-m', 'venv', join(dir, 'venv')]);
      if (this.cancelado) return;
      if (codigo !== 0 || !existsSync(venvPython)) {
        this.cerrarPaso(pasoVenv, false);
        this.pantallaFallo();
        return;
      }
    }
    this.cerrarPaso(pasoVenv, true);

    // 3. dependencias (pip reanuda/salta lo ya instalado)
    const pasoDeps = this.nuevoPaso(t.pasoDeps);
    let codigo = await this.correr(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    if (codigo === 0 && !this.cancelado) {
      codigo = await this.correr(venvPython, ['-m', 'pip', 'install', ...DEPENDENCIAS]);
    }
    if (this.cancelado) return;
    if (codigo !== 0) {
      this.cerrarPaso(pasoDeps, false);
      this.pantallaFallo();
      return;
    }
    this.cerrarPaso(pasoDeps, true);

    // 4. sidecar desde el bundle + ajustes (el cliente de voz se recrea)
    const pasoScript = this.nuevoPaso(t.pasoScript);
    const script = join(dir, 'servidor_voz.py');
    writeFileSync(script, servidorVozPy, 'utf8');
    const ajustes = this.plugin.ajustes;
    ajustes.vozActivada = true;
    ajustes.vozPython = venvPython;
    ajustes.vozScript = script;
    ajustes.vozCwd = dir;
    await this.plugin.guardarAjustes();
    this.cerrarPaso(pasoScript, true);

    // 5. arrancar y esperar los modelos (se descargan la primera vez)
    const pasoArranque = this.nuevoPaso(t.pasoArranque);
    await this.plugin.voz().asegurarSidecar();
    const inicio = Date.now();
    let avisado = false;
    for (;;) {
      if (this.cancelado) return;
      const salud = await this.plugin.voz().salud();
      if (salud.stt && salud.kokoro) break;
      if (salud.apagado && Date.now() - inicio > 30_000) {
        this.log(t.noArranco);
        this.cerrarPaso(pasoArranque, false);
        this.pantallaFallo();
        return;
      }
      if (!salud.apagado && !avisado) {
        avisado = true;
        this.log(t.descargandoModelos);
      }
      if (Date.now() - inicio > 30 * 60_000) {
        this.cerrarPaso(pasoArranque, false);
        this.pantallaFallo();
        return;
      }
      await espera(5000);
    }
    this.cerrarPaso(pasoArranque, true);
    new Notice(t.listo);
    this.close();
  }
}
