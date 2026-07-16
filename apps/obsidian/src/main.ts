// Nightly Journal: plugin de Obsidian que reusa el núcleo de apps/diario
// (SesionDiario, aplicador, RAG) apuntándolo a la ruta del vault. Solo
// desktop (isDesktopOnly): el núcleo usa node:fs y child_process.

import { addIcon, FileSystemAdapter, Notice, Plugin } from 'obsidian';
import { fijarTransporte } from '../../diario/src/red.js';
import { SesionDiario } from '../../diario/src/sesion.js';
import { Rag } from '../../diario/src/rag.js';
import type { Config } from '../../diario/src/config.js';
import type { Idioma } from '../../diario/src/idioma.js';
import { AJUSTES_DEFECTO, idiomaDeObsidian, PestanaAjustes, type AjustesDiario } from './ajustes.js';
import { transporteRequestUrl } from './transporte.js';
import { ClienteVoz } from './voz.js';
import { ICONO_PLUGIN } from './icono.js';
import { TIPO_VISTA_DIARIO, VistaDiario } from './vista.js';

export default class DiarioPlugin extends Plugin {
  ajustes: AjustesDiario = { ...AJUSTES_DEFECTO };
  // La sesión vive en el plugin (la vista solo renderiza): sobrevive a
  // cambios de pestaña, igual que el `sesion` module-level del servidor web.
  sesion: SesionDiario | null = null;
  rag: Rag | null = null;
  private clienteVoz: ClienteVoz | null = null;

  async onload(): Promise<void> {
    await this.cargarAjustes();
    // dentro de Obsidian el fetch del renderer es bloqueado por CORS contra
    // localhost: TODO el HTTP del núcleo va por requestUrl
    fijarTransporte(transporteRequestUrl);

    // los nombres de comandos/ribbon se fijan al cargar: cambiar el idioma
    // los actualiza tras recargar Obsidian (suficiente para algo tan menor)
    const en = this.idioma() === 'en';
    addIcon('nightly-journal', ICONO_PLUGIN);
    this.registerView(TIPO_VISTA_DIARIO, hoja => new VistaDiario(hoja, this));
    this.addRibbonIcon('nightly-journal', en ? 'Nightly journal' : 'Diario nocturno', () => void this.abrirVista());
    this.addCommand({
      id: 'abrir',
      name: en ? 'Open nightly journal' : 'Abrir diario nocturno',
      callback: () => void this.abrirVista(),
    });
    this.addCommand({
      id: 'nueva-sesion',
      name: en ? 'New session' : 'Nueva sesión',
      callback: () => {
        this.sesion = null;
        void this.abrirVista(true);
      },
    });
    this.addSettingTab(new PestanaAjustes(this.app, this));

    // el índice de memoria se refresca cuando Obsidian terminó de cargar
    this.app.workspace.onLayoutReady(() => void this.refrescarRag('arranque'));
  }

  onunload(): void {
    fijarTransporte(); // restaura el fetch por defecto del núcleo
    this.clienteVoz?.apagar(); // solo mata el sidecar si lo levantó el plugin
  }

  // Idioma efectivo: 'auto' (defecto) hereda el idioma configurado en
  // Obsidian; 'es'/'en' explícitos lo fijan.
  idioma(): Idioma {
    return this.ajustes.idioma === 'auto' ? idiomaDeObsidian() : this.ajustes.idioma;
  }

  // Cliente de voz perezoso: se recrea cuando cambian los ajustes.
  voz(): ClienteVoz {
    this.clienteVoz ??= new ClienteVoz({
      activada: this.ajustes.vozActivada,
      url: this.ajustes.vozUrl,
      python: this.ajustes.vozPython,
      script: this.ajustes.vozScript,
      cwd: this.ajustes.vozCwd,
    });
    return this.clienteVoz;
  }

  // ── vault y config ────────────────────────────────────────────

  rutaVault(): string | null {
    const adaptador = this.app.vault.adapter;
    return adaptador instanceof FileSystemAdapter ? adaptador.getBasePath() : null;
  }

  configActual(): Config {
    const vault = this.rutaVault();
    if (!vault) throw new Error('Este plugin solo funciona en Obsidian de escritorio.');
    return {
      vault,
      ollamaUrl: this.ajustes.ollamaUrl,
      modelo: this.ajustes.modelo,
      modeloExtractor: this.ajustes.modeloExtractor,
      modeloEmbed: this.ajustes.modeloEmbed || undefined,
      preguntasMax: this.ajustes.preguntasMax,
      idioma: this.idioma(),
      git: this.ajustes.gitAutoCommit,
    };
  }

  nuevaSesion(): SesionDiario {
    // el rag se recrea perezosamente si algo lo anuló (ej. cambio de
    // ajustes): el constructor solo carga el índice de disco, es barato
    if (!this.rag && this.ajustes.modeloEmbed) {
      try {
        const cfg = this.configActual();
        this.rag = new Rag(cfg.vault, cfg);
      } catch {
        this.rag = null;
      }
    }
    this.sesion = new SesionDiario(this.configActual(), this.rag?.activo ? this.rag : undefined);
    return this.sesion;
  }

  // ── memoria de largo plazo ────────────────────────────────────

  async refrescarRag(motivo: string): Promise<void> {
    if (!this.ajustes.modeloEmbed) return;
    try {
      this.rag ??= new Rag(this.configActual().vault, this.configActual());
      const r = await this.rag.reindexar();
      if (this.rag.activo && r.embebidas) {
        console.log(`[nightly-journal] rag ${motivo}: ${r.embebidas} nota(s) embebida(s) · ${r.total} en el índice`);
      }
    } catch (e) {
      console.log(`[nightly-journal] rag desactivado: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── vista ─────────────────────────────────────────────────────

  async abrirVista(reiniciar = false): Promise<void> {
    const { workspace } = this.app;
    const hojas = workspace.getLeavesOfType(TIPO_VISTA_DIARIO);
    if (hojas.length) {
      workspace.revealLeaf(hojas[0]);
      if (reiniciar && hojas[0].view instanceof VistaDiario) await hojas[0].view.iniciarSesion();
      return;
    }
    const hoja = workspace.getLeaf(true);
    await hoja.setViewState({ type: TIPO_VISTA_DIARIO, active: true });
    workspace.revealLeaf(hoja);
    if (this.rutaVault() === null)
      new Notice(
        this.idioma() === 'en' ? 'Nightly Journal only works on desktop.' : 'Nightly Journal solo funciona en escritorio.'
      );
  }

  // ── ajustes ───────────────────────────────────────────────────

  async cargarAjustes(): Promise<void> {
    const guardados = (await this.loadData()) as Partial<AjustesDiario> | null;
    this.ajustes = { ...AJUSTES_DEFECTO, ...guardados };
  }

  async guardarAjustes(): Promise<void> {
    await this.saveData(this.ajustes);
    this.rag = null; // config pudo cambiar (ollamaUrl/modeloEmbed): se recrea
    this.clienteVoz = null; // ídem para la voz (sin matar un sidecar externo)
  }
}
