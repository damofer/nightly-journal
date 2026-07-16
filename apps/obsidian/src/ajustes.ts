// Ajustes del plugin: mapean el Config del núcleo. Se persisten con
// loadData/saveData de Obsidian (data.json del plugin, no config.json).

import { getLanguage, PluginSettingTab, Setting, type App } from 'obsidian';
import type { Idioma } from '../../diario/src/idioma.js';
import type DiarioPlugin from './main.js';

// Idioma de la app de Obsidian ('en' para todo lo que no sea español).
// getLanguage() existe desde Obsidian 1.8.7; minAppVersion lo garantiza.
export function idiomaDeObsidian(): Idioma {
  try {
    return getLanguage().toLowerCase().startsWith('es') ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

export interface AjustesDiario {
  ollamaUrl: string;
  modelo: string;
  modeloExtractor: string;
  modeloEmbed: string;
  preguntasMax: number;
  // 'auto' = heredar el idioma configurado en Obsidian (defecto)
  idioma: Idioma | 'auto';
  // Deshabilitado por defecto: crea un repo git DENTRO del vault del
  // usuario (habilita el botón deshacer). Jamás sin permiso explícito.
  gitAutoCommit: boolean;
  // Voz (sidecar local Whisper+Kokoro). Sin sidecar el plugin es solo texto.
  vozActivada: boolean;
  vozUrl: string;
  vozPython: string;
  vozScript: string;
  vozCwd: string;
}

export const AJUSTES_DEFECTO: AjustesDiario = {
  ollamaUrl: 'http://localhost:11434',
  modelo: 'gemma3:4b',
  modeloExtractor: 'gemma3:4b',
  modeloEmbed: 'embeddinggemma',
  preguntasMax: 4,
  idioma: 'auto',
  gitAutoCommit: false,
  vozActivada: true,
  vozUrl: 'http://127.0.0.1:8765',
  vozPython: '',
  vozScript: '',
  vozCwd: '',
};

const ETIQUETAS = {
  es: {
    ollamaUrl: 'URL de Ollama',
    ollamaUrlDesc: 'Dónde corre Ollama (por defecto http://localhost:11434).',
    modelo: 'Modelo de entrevista',
    modeloDesc: 'Rápido y conversacional (ej. gemma3:4b).',
    modeloExtractor: 'Modelo de extracción',
    modeloExtractorDesc: 'Puede ser más pesado que el de entrevista (ej. gemma3:12b): necesita precisión, no velocidad.',
    modeloEmbed: 'Modelo de memoria (embeddings)',
    modeloEmbedDesc: 'Para la memoria de largo plazo. Actívalo una vez con: ollama pull embeddinggemma. Vacío = sin memoria.',
    preguntasMax: 'Preguntas guiadas por sesión',
    preguntasMaxDesc: 'Después de estas preguntas pasa al cierre ("¿algo más?").',
    idioma: 'Idioma',
    idiomaDesc: 'Entrevista, interfaz y extracción. "Automático" sigue el idioma de Obsidian. El esquema de carpetas de un vault ya usado no cambia.',
    idiomaAuto: 'Automático (idioma de Obsidian)',
    git: 'Auto-commit con git',
    gitDesc: 'ADVERTENCIA: crea un repositorio git DENTRO de tu vault y hace un commit por sesión. Habilita el botón deshacer. Déjalo apagado si tu vault ya está en git o usas otro plugin de git.',
    voz: 'Voz',
    vozDesc: 'Hablar con el diario y que te lea las respuestas. Requiere el sidecar de voz local (Whisper + Kokoro); sin él, el plugin funciona en solo texto.',
    vozUrl: 'URL del sidecar de voz',
    vozUrlDesc: 'Dónde corre el sidecar (por defecto http://127.0.0.1:8765).',
    vozAvanzado: 'Arranque automático del sidecar (avanzado)',
    vozAvanzadoDesc: 'Si estas tres rutas están configuradas y el sidecar no responde, el plugin lo levanta solo: ruta del python del venv, ruta de servidor_voz.py y carpeta de trabajo.',
    vozPython: 'Python del sidecar',
    vozScript: 'Script del sidecar (servidor_voz.py)',
    vozCwd: 'Carpeta de trabajo del sidecar',
  },
  en: {
    ollamaUrl: 'Ollama URL',
    ollamaUrlDesc: 'Where Ollama runs (default http://localhost:11434).',
    modelo: 'Interview model',
    modeloDesc: 'Fast and conversational (e.g. gemma3:4b).',
    modeloExtractor: 'Extraction model',
    modeloExtractorDesc: 'Can be heavier than the interview model (e.g. gemma3:12b): it needs precision, not speed.',
    modeloEmbed: 'Memory model (embeddings)',
    modeloEmbedDesc: 'For long-term memory. Enable once with: ollama pull embeddinggemma. Empty = no memory.',
    preguntasMax: 'Guided questions per session',
    preguntasMaxDesc: 'After these questions it moves to the wrap-up ("anything else?").',
    idioma: 'Language',
    idiomaDesc: "Interview, UI and extraction. \"Automatic\" follows Obsidian's language. The folder schema of an already-used vault does not change.",
    idiomaAuto: 'Automatic (Obsidian language)',
    git: 'Auto-commit with git',
    gitDesc: 'WARNING: creates a git repository INSIDE your vault and commits once per session. Enables the undo button. Keep it off if your vault is already in git or you use another git plugin.',
    voz: 'Voice',
    vozDesc: 'Talk to the journal and have it read replies aloud. Requires the local voice sidecar (Whisper + Kokoro); without it the plugin works text-only.',
    vozUrl: 'Voice sidecar URL',
    vozUrlDesc: 'Where the sidecar runs (default http://127.0.0.1:8765).',
    vozAvanzado: 'Sidecar auto-start (advanced)',
    vozAvanzadoDesc: 'If these three paths are set and the sidecar is not responding, the plugin starts it: venv python path, servidor_voz.py path and working directory.',
    vozPython: 'Sidecar python',
    vozScript: 'Sidecar script (servidor_voz.py)',
    vozCwd: 'Sidecar working directory',
  },
} as const;

export class PestanaAjustes extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: DiarioPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const a = this.plugin.ajustes;
    const t = ETIQUETAS[this.plugin.idioma()];
    containerEl.empty();

    new Setting(containerEl)
      .setName(t.idioma)
      .setDesc(t.idiomaDesc)
      .addDropdown(d =>
        d
          .addOption('auto', t.idiomaAuto)
          .addOption('es', 'Español')
          .addOption('en', 'English')
          .setValue(a.idioma)
          .onChange(async valor => {
            a.idioma = valor === 'es' || valor === 'en' ? valor : 'auto';
            this.plugin.sesion = null; // la próxima sesión arranca en el idioma nuevo
            await this.plugin.guardarAjustes();
            this.display(); // re-pinta las etiquetas en el idioma elegido
          })
      );

    new Setting(containerEl)
      .setName(t.ollamaUrl)
      .setDesc(t.ollamaUrlDesc)
      .addText(txt =>
        txt.setValue(a.ollamaUrl).onChange(async valor => {
          a.ollamaUrl = valor.trim() || AJUSTES_DEFECTO.ollamaUrl;
          await this.plugin.guardarAjustes();
        })
      );

    new Setting(containerEl)
      .setName(t.modelo)
      .setDesc(t.modeloDesc)
      .addText(txt =>
        txt.setValue(a.modelo).onChange(async valor => {
          a.modelo = valor.trim() || AJUSTES_DEFECTO.modelo;
          await this.plugin.guardarAjustes();
        })
      );

    new Setting(containerEl)
      .setName(t.modeloExtractor)
      .setDesc(t.modeloExtractorDesc)
      .addText(txt =>
        txt.setValue(a.modeloExtractor).onChange(async valor => {
          a.modeloExtractor = valor.trim() || AJUSTES_DEFECTO.modeloExtractor;
          await this.plugin.guardarAjustes();
        })
      );

    new Setting(containerEl)
      .setName(t.modeloEmbed)
      .setDesc(t.modeloEmbedDesc)
      .addText(txt =>
        txt.setValue(a.modeloEmbed).onChange(async valor => {
          a.modeloEmbed = valor.trim();
          this.plugin.rag = null; // se recrea con el modelo nuevo
          await this.plugin.guardarAjustes();
        })
      );

    new Setting(containerEl)
      .setName(t.preguntasMax)
      .setDesc(t.preguntasMaxDesc)
      .addSlider(s =>
        s
          .setLimits(1, 8, 1)
          .setValue(a.preguntasMax)
          .onChange(async valor => {
            a.preguntasMax = valor;
            await this.plugin.guardarAjustes();
          })
      );

    new Setting(containerEl)
      .setName(t.git)
      .setDesc(t.gitDesc)
      .addToggle(tg =>
        tg.setValue(a.gitAutoCommit).onChange(async valor => {
          a.gitAutoCommit = valor;
          await this.plugin.guardarAjustes();
        })
      );

    new Setting(containerEl)
      .setName(t.voz)
      .setDesc(t.vozDesc)
      .addToggle(tg =>
        tg.setValue(a.vozActivada).onChange(async valor => {
          a.vozActivada = valor;
          await this.plugin.guardarAjustes();
        })
      );

    new Setting(containerEl)
      .setName(t.vozUrl)
      .setDesc(t.vozUrlDesc)
      .addText(txt =>
        txt.setValue(a.vozUrl).onChange(async valor => {
          a.vozUrl = valor.trim() || AJUSTES_DEFECTO.vozUrl;
          await this.plugin.guardarAjustes();
        })
      );

    new Setting(containerEl).setName(t.vozAvanzado).setDesc(t.vozAvanzadoDesc).setHeading();

    new Setting(containerEl).setName(t.vozPython).addText(txt =>
      txt.setValue(a.vozPython).onChange(async valor => {
        a.vozPython = valor.trim();
        await this.plugin.guardarAjustes();
      })
    );

    new Setting(containerEl).setName(t.vozScript).addText(txt =>
      txt.setValue(a.vozScript).onChange(async valor => {
        a.vozScript = valor.trim();
        await this.plugin.guardarAjustes();
      })
    );

    new Setting(containerEl).setName(t.vozCwd).addText(txt =>
      txt.setValue(a.vozCwd).onChange(async valor => {
        a.vozCwd = valor.trim();
        await this.plugin.guardarAjustes();
      })
    );
  }
}
