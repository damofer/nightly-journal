// Asistente de voz: deja el sidecar local (Whisper + Kokoro) funcionando sin
// que el usuario toque una terminal. El plugin es desktop-only, así que puede
// detectar Python, crear un venv propio FUERA del vault (para no ensuciar la
// sincronización), instalar las dependencias probadas, escribir
// servidor_voz.py desde el propio bundle y arrancarlo — con pasos y log en
// vivo, y todo 100% local.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Modal, Notice, Setting, type App } from 'obsidian';
import servidorVozPy from '../../voz/servidor_voz.py';
import type { AjustesDiario } from './ajustes.js';
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

// Python 3.10–3.12: kokoro 0.9.4 declara Requires-Python >=3.10,<3.13
// (verificado: pip en 3.14 lo rechaza de plano). La "última" de python.org
// es 3.13/3.14, así que el botón baja el instalador CORRECTO directamente.
const URL_PYTHON =
  process.platform === 'win32'
    ? 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe'
    : process.platform === 'darwin'
      ? 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg'
      : 'https://www.python.org/downloads/release/python-31210/';

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
    btnPython: '⬇ descargar Python 3.12',
    pasoPython: 'buscar Python (3.10–3.12)',
    sinPython:
      'No encontré Python en este equipo. El motor de voz necesita Python 3.10–3.12 — ojo: la "última" de python.org (3.13/3.14) aún NO sirve, kokoro no la soporta. El botón descarga el instalador correcto de 3.12; en Windows marca "Add python.exe to PATH" al instalar y luego pulsa reintentar.',
    sinPythonVersion:
      'Encontré {version}, pero el motor de voz necesita Python 3.10–3.12 (kokoro aún no soporta 3.13+). El botón descarga el instalador de 3.12 — puede convivir con el Python que ya tienes. En Windows marca "Add python.exe to PATH" al instalar y luego pulsa reintentar.',
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
    btnPython: '⬇ download Python 3.12',
    pasoPython: 'find Python (3.10–3.12)',
    sinPython:
      'I couldn\'t find Python on this machine. The voice engine needs Python 3.10–3.12 — note: the "latest" from python.org (3.13/3.14) does NOT work yet, kokoro doesn\'t support it. The button downloads the right 3.12 installer; on Windows tick "Add python.exe to PATH" while installing, then hit retry.',
    sinPythonVersion:
      'I found {version}, but the voice engine needs Python 3.10–3.12 (kokoro doesn\'t support 3.13+ yet). The button downloads the 3.12 installer — it can live alongside the Python you already have. On Windows tick "Add python.exe to PATH" while installing, then hit retry.',
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

// El asistente escribe el sidecar una sola vez, pero las versiones nuevas
// del plugin traen el .py corregido dentro del bundle: si el script
// configurado es el GESTIONADO (vive en dirVoz), se refresca al cargar el
// plugin para que los fixes lleguen sin reinstalar nada. Los scripts
// apuntados a mano (p. ej. el del monorepo) no se tocan.
export function refrescarScriptGestionado(ajustes: AjustesDiario): void {
  try {
    if (!ajustes.vozScript) return;
    const gestionado = join(dirVoz(), 'servidor_voz.py');
    if (resolve(ajustes.vozScript) !== resolve(gestionado) || !existsSync(gestionado)) return;
    if (readFileSync(gestionado, 'utf8') !== servidorVozPy) writeFileSync(gestionado, servidorVozPy, 'utf8');
  } catch {
    // sin permisos o similar: el sidecar existente sigue funcionando
  }
}

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

  // Devuelve el primer Python compatible; si solo hay versiones fuera de
  // rango (ej. la 3.14 "última" de python.org), las reporta para que la
  // pantalla de fallo diga exactamente qué pasa en vez de "no encontré".
  private async detectarPython(): Promise<{
    python: { cmd: string; args: string[]; version: string } | null;
    fueraDeRango: string[];
  }> {
    const fueraDeRango: string[] = [];
    for (const [cmd, args] of CANDIDATOS_PYTHON) {
      const version = await this.probarPython(cmd, args);
      const m = version?.match(/Python 3\.(\d+)\./);
      if (!version || !m) continue;
      if (Number(m[1]) >= 10 && Number(m[1]) <= 12) return { python: { cmd, args, version }, fueraDeRango };
      if (!fueraDeRango.includes(version)) fueraDeRango.push(version);
    }
    return { python: null, fueraDeRango };
  }

  // ── pantallas de salida ───────────────────────────────────────

  private pantallaSinPython(fueraDeRango: string[]): void {
    const texto = fueraDeRango.length
      ? this.t.sinPythonVersion.replace('{version}', fueraDeRango.join(', '))
      : this.t.sinPython;
    this.pasosEl.createDiv({ cls: 'diario-tarjeta-texto', text: texto });
    this.botonesEl.empty();
    new Setting(this.botonesEl)
      .addButton(b =>
        b
          .setButtonText(this.t.btnPython)
          .setCta()
          .onClick(() => window.open(URL_PYTHON))
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
    const { python, fueraDeRango } = await this.detectarPython();
    if (this.cancelado) return;
    if (!python) {
      this.cerrarPaso(pasoPython, false);
      this.pantallaSinPython(fueraDeRango);
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
