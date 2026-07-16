// La pestaña del diario: puerto de la UI web (ui/index.html) hablando con
// SesionDiario EN PROCESO — sin servidor HTTP. La vista solo renderiza;
// la sesión vive en el plugin (sobrevive a cambios de pestaña).
//
// Fase 2: voz (TTS Kokoro por oraciones con prefetch, mic Whisper, manos
// libres con detección de pausa) y adjuntos (fotos multimodales, PDF/txt).

import { Buffer } from 'node:buffer';
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { TEXTOS_UI, type TextosUi } from '../../diario/src/idioma.js';
import { energiasRecientes, racha } from '../../diario/src/racha.js';
import { ConsultaDiario } from '../../diario/src/consulta.js';
import type { ResultadoRag } from '../../diario/src/rag.js';
import type { ItemPlan } from '../../diario/src/aplicador.js';
import { estadoOllama } from './transporte.js';
import type { SaludVoz, VozKokoro } from './voz.js';
import type DiarioPlugin from './main.js';

export const TIPO_VISTA_DIARIO = 'nightly-journal';

const EXT_IMAGEN = /\.(jpe?g|png|gif|webp|bmp)$/i;

const plantilla = (s: string, datos: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (datos[k] !== undefined ? String(datos[k]) : m));

const dividirOraciones = (texto: string) =>
  texto.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);

const MIME_AUDIO = () =>
  MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';

// manos libres: detección de habla por energía (RMS del AnalyserNode)
const UMBRAL_MINIMO = 0.012;
const SILENCIO_MS = 1300; // pausa que dispara el envío
const HABLA_MINIMA_MS = 350; // menos que esto es un ruido, no una frase
const REINICIO_MS = 15000; // recorta el silencio inicial acumulado

export class VistaDiario extends ItemView {
  private chatEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private entradaEl!: HTMLTextAreaElement;
  private btnEnviar!: HTMLButtonElement;
  private btnTerminar!: HTMLButtonElement;
  private btnAdjuntar!: HTMLButtonElement;
  private btnMic!: HTMLButtonElement;
  private btnManosLibres!: HTMLButtonElement;
  private btnVoz!: HTMLButtonElement;
  private selectorVoz!: HTMLSelectElement;
  private archivoEl!: HTMLInputElement;
  private fechaEl!: HTMLElement;
  private rachaEl!: HTMLElement;
  private chipVozEl!: HTMLElement;
  private avisoAudioEl!: HTMLButtonElement;
  private indicadorEl: HTMLElement | null = null;
  private enviando = false;
  private cerrada = false;

  // ── pestaña consultar (preguntas a la memoria RAG) ──
  private modo: 'registrar' | 'consultar' = 'registrar';
  private consultaChatEl!: HTMLElement;
  private tabRegistrar!: HTMLButtonElement;
  private tabConsultar!: HTMLButtonElement;
  private consulta: ConsultaDiario | null = null;
  private consultando = false;

  // ── estado de voz ──
  private saludVoz: SaludVoz = { stt: false, kokoro: false };
  private motor: 'kokoro' | 'off' | null = null;
  private colaAudio: Promise<void> = Promise.resolve();
  private audiosEnCola = 0;
  private audioActual: HTMLAudioElement | null = null;
  private bloqueados: Blob[] = [];
  private grabando = false;
  private grabadorManual: MediaRecorder | null = null;

  // ── manos libres ──
  private manos = {
    activo: false,
    stream: null as MediaStream | null,
    contexto: null as AudioContext | null,
    analizador: null as AnalyserNode | null,
    grabador: null as MediaRecorder | null,
    trozos: [] as Blob[],
    escuchando: false,
    hablando: false,
    inicioEscucha: 0,
    primerSonido: 0,
    ultimoSonido: 0,
    ruidoBase: 0.006,
    calibraciones: 0,
    graciaHasta: 0,
  };

  constructor(
    hoja: WorkspaceLeaf,
    private plugin: DiarioPlugin
  ) {
    super(hoja);
  }

  getViewType(): string {
    return TIPO_VISTA_DIARIO;
  }

  getDisplayText(): string {
    return this.plugin.idioma() === 'en' ? 'Nightly journal' : 'Diario nocturno';
  }

  getIcon(): string {
    return 'moon';
  }

  private t(): TextosUi {
    return TEXTOS_UI[this.plugin.idioma()];
  }

  async onOpen(): Promise<void> {
    this.cerrada = false;
    this.montar();
    this.registerInterval(window.setInterval(() => void this.vigilarVoz(), 2500));
    void this.vigilarVoz();
    void this.plugin.voz().asegurarSidecar();
    await this.iniciarSesion();
  }

  async onClose(): Promise<void> {
    this.cerrada = true;
    this.manosDesactivar();
    this.audioActual?.pause();
    this.grabadorManual?.stop();
  }

  // ── esqueleto de la vista ─────────────────────────────────────

  private montar(): void {
    const t = this.t();
    const raiz = this.contentEl;
    raiz.empty();
    raiz.addClass('diario-vista');

    const encabezado = raiz.createDiv({ cls: 'diario-encabezado' });
    encabezado.createSpan({ cls: 'diario-marca', text: t.marca });
    this.fechaEl = encabezado.createSpan({ cls: 'diario-fecha' });
    const pestanas = encabezado.createDiv({ cls: 'diario-pestanas' });
    this.tabRegistrar = pestanas.createEl('button', { cls: 'diario-pestana diario-pestana-activa', text: t.pestanaRegistrar });
    this.tabConsultar = pestanas.createEl('button', { cls: 'diario-pestana', text: t.pestanaConsultar });
    this.registerDomEvent(this.tabRegistrar, 'click', () => this.cambiarModo('registrar'));
    this.registerDomEvent(this.tabConsultar, 'click', () => this.cambiarModo('consultar'));
    this.rachaEl = encabezado.createSpan({ cls: 'diario-racha' });
    this.rachaEl.hide();
    this.chipVozEl = encabezado.createSpan({ cls: 'diario-chip-voz', text: '…' });

    this.chatEl = raiz.createDiv({ cls: 'diario-chat' });
    this.consultaChatEl = raiz.createDiv({ cls: 'diario-chat' });
    this.consultaChatEl.hide();

    this.avisoAudioEl = raiz.createEl('button', { cls: 'diario-aviso-audio', text: t.avisoAudio });
    this.avisoAudioEl.hide();
    this.registerDomEvent(this.avisoAudioEl, 'click', () => {
      this.avisoAudioEl.hide();
      const rezagados = this.bloqueados.splice(0);
      this.encolar(async () => {
        for (const blob of rezagados) await this.reproducirBlob(blob);
      });
    });

    const pie = raiz.createDiv({ cls: 'diario-pie' });
    this.chipsEl = pie.createDiv({ cls: 'diario-chips' });
    const composer = pie.createDiv({ cls: 'diario-composer' });
    this.btnAdjuntar = composer.createEl('button', { cls: 'diario-boton diario-redondo', text: '📎' });
    this.btnAdjuntar.setAttr('title', t.adjuntar);
    this.btnMic = composer.createEl('button', { cls: 'diario-boton diario-redondo', text: '🎙️' });
    this.btnMic.setAttr('title', t.hablar);
    this.entradaEl = composer.createEl('textarea', {
      cls: 'diario-entrada',
      attr: { rows: '1', placeholder: t.placeholder },
    });
    this.btnEnviar = composer.createEl('button', { cls: 'diario-boton diario-primario diario-redondo', text: '➤' });
    this.btnEnviar.setAttr('title', t.enviar);

    this.archivoEl = composer.createEl('input', {
      type: 'file',
      attr: { accept: 'image/*,.pdf,.txt,.md', multiple: 'true' },
    });
    this.archivoEl.hide();

    const acciones = pie.createDiv({ cls: 'diario-acciones' });
    this.btnTerminar = acciones.createEl('button', { cls: 'diario-boton diario-tenue', text: t.cerrarDia });
    this.btnManosLibres = acciones.createEl('button', { cls: 'diario-boton diario-tenue', text: t.manosLibresNo });
    this.btnVoz = acciones.createEl('button', { cls: 'diario-boton diario-tenue', text: t.motorOff });
    this.selectorVoz = acciones.createEl('select', { cls: 'diario-selector-voz' });
    this.selectorVoz.hide();

    this.registerDomEvent(this.btnEnviar, 'click', () => void this.enviar(this.entradaEl.value));
    this.registerDomEvent(this.btnTerminar, 'click', () => void this.terminar());
    this.registerDomEvent(this.btnAdjuntar, 'click', () => this.archivoEl.click());
    this.registerDomEvent(this.archivoEl, 'change', () => void this.adjuntarArchivos());
    this.registerDomEvent(this.btnMic, 'click', () => void this.alternarMic());
    this.registerDomEvent(this.btnManosLibres, 'click', () =>
      this.manos.activo ? this.manosDesactivar() : void this.manosActivar()
    );
    this.registerDomEvent(this.btnVoz, 'click', () => {
      const opciones: ('kokoro' | 'off')[] = this.saludVoz.kokoro ? ['kokoro', 'off'] : ['off'];
      const i = opciones.indexOf(this.motor ?? 'off');
      this.motor = opciones[(i + 1) % opciones.length];
      this.pintarBotonVoz();
    });
    this.registerDomEvent(this.entradaEl, 'keydown', evento => {
      if (evento.key === 'Enter' && !evento.shiftKey) {
        evento.preventDefault();
        void this.enviar(this.entradaEl.value);
      }
    });
    this.registerDomEvent(this.entradaEl, 'input', () => {
      this.entradaEl.setCssStyles({ height: 'auto' });
      this.entradaEl.setCssStyles({ height: `${Math.min(this.entradaEl.scrollHeight, 130)}px` });
    });

    // tick de manos libres (el gate interno decide si escucha)
    this.registerInterval(window.setInterval(() => this.manosTick(), 80));

    this.habilitar(false);
  }

  // ── helpers de chat ───────────────────────────────────────────

  private burbuja(
    clase: 'asistente' | 'usuario' | 'sistema' | 'error',
    texto: string,
    contenedor: HTMLElement = this.chatEl
  ): HTMLElement {
    const div = contenedor.createDiv({ cls: `diario-burbuja diario-${clase}`, text: texto });
    this.bajarScroll(contenedor);
    return div;
  }

  private mostrarIndicador(texto: string, contenedor: HTMLElement = this.chatEl): void {
    this.quitarIndicador();
    this.indicadorEl = contenedor.createDiv({ cls: 'diario-escribiendo' });
    this.indicadorEl.createSpan({ text: '● ' });
    this.indicadorEl.appendText(texto);
    this.bajarScroll(contenedor);
  }

  private quitarIndicador(): void {
    this.indicadorEl?.remove();
    this.indicadorEl = null;
  }

  private bajarScroll(contenedor: HTMLElement = this.chatEl): void {
    contenedor.scrollTop = contenedor.scrollHeight;
  }

  private habilitar(si: boolean): void {
    this.entradaEl.disabled = !si;
    this.btnEnviar.disabled = !si;
    this.btnTerminar.disabled = !si;
    this.btnAdjuntar.disabled = !si;
    this.btnMic.disabled = !si || !this.saludVoz.stt;
    if (si && !this.manos.activo) this.entradaEl.focus();
  }

  // ── voz: estado del sidecar ───────────────────────────────────

  private async vigilarVoz(): Promise<void> {
    if (this.cerrada) return;
    const t = this.t();
    const salud = await this.plugin.voz().salud();
    this.saludVoz = salud;
    this.poblarVoces(salud.voces_kokoro, salud.voz_defecto);
    if (this.motor === null && salud.kokoro) {
      this.motor = 'kokoro';
      this.pintarBotonVoz();
    }
    if (salud.stt && salud.kokoro) {
      this.chipVozEl.setText(t.vozLista);
      this.chipVozEl.addClass('diario-voz-lista');
      const sesion = this.plugin.sesion;
      this.btnMic.disabled =
        this.consultando || (this.modo === 'registrar' && (!sesion || sesion.fase !== 'entrevista'));
    } else if (salud.apagado) {
      this.chipVozEl.setText(t.soloTexto);
      this.chipVozEl.removeClass('diario-voz-lista');
    } else {
      this.chipVozEl.setText(t.vozCargando);
    }
  }

  private poblarVoces(voces?: VozKokoro[], defecto?: Record<string, string>): void {
    if (!voces?.length || this.selectorVoz.options.length) return;
    const idioma = this.plugin.idioma();
    const propias = voces.filter(v => (v.idioma ?? 'es') === idioma);
    if (!propias.length) return;
    const generos = this.t().generos;
    for (const v of propias) {
      const op = this.selectorVoz.createEl('option', { text: `${v.nombre} · ${generos[v.genero] ?? v.genero}` });
      op.value = v.id;
    }
    const preferida = defecto?.[idioma];
    if (preferida && propias.some(v => v.id === preferida)) this.selectorVoz.value = preferida;
    this.pintarBotonVoz();
  }

  private pintarBotonVoz(): void {
    const t = this.t();
    this.btnVoz.setText(this.motor === 'kokoro' ? t.motorKokoro : t.motorOff);
    if (this.motor === 'kokoro' && this.selectorVoz.options.length) this.selectorVoz.show();
    else this.selectorVoz.hide();
  }

  // ── voz: TTS por oraciones con prefetch ───────────────────────

  private hablar(texto: string): void {
    if (this.motor !== 'kokoro' || !this.saludVoz.kokoro) return;
    const oraciones = dividirOraciones(texto);
    if (!oraciones.length) return;
    this.encolar(() => this.reproducirSecuencia(oraciones));
  }

  private encolar(tarea: () => Promise<void>): void {
    this.audiosEnCola++;
    this.colaAudio = this.colaAudio
      .then(tarea)
      .catch(() => {})
      .finally(() => {
        this.audiosEnCola--;
      });
  }

  private pedirTts(texto: string): Promise<Blob | null> {
    const voz = this.selectorVoz.value || null;
    return this.plugin
      .voz()
      .tts(texto, voz, this.plugin.idioma())
      .then(datos => (datos ? new Blob([datos], { type: 'audio/wav' }) : null));
  }

  private async reproducirSecuencia(oraciones: string[]): Promise<void> {
    let siguiente = this.pedirTts(oraciones[0]);
    for (let i = 0; i < oraciones.length; i++) {
      if (this.cerrada) return;
      const blob = await siguiente;
      if (i + 1 < oraciones.length) siguiente = this.pedirTts(oraciones[i + 1]);
      if (blob) await this.reproducirBlob(blob);
    }
  }

  private async reproducirBlob(blob: Blob): Promise<void> {
    if (this.cerrada) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.audioActual = audio;
    try {
      await audio.play();
    } catch {
      this.bloqueados.push(blob);
      this.avisoAudioEl.show();
      URL.revokeObjectURL(url);
      return;
    }
    this.avisoAudioEl.hide();
    await new Promise<void>(fin => {
      audio.onended = () => fin();
      audio.onerror = () => fin();
    });
    URL.revokeObjectURL(url);
    this.audioActual = null;
  }

  // ── voz: micrófono manual → STT ───────────────────────────────

  private async transcribirYEnviar(blob: Blob, mime: string): Promise<void> {
    const t = this.t();
    this.mostrarIndicador(t.transcribiendo);
    const texto = await this.plugin.voz().stt(await blob.arrayBuffer(), mime, this.plugin.idioma());
    this.quitarIndicador();
    if (texto && texto.length > 1) void this.enviar(texto);
    else this.burbuja('sistema', t.noEntendi);
  }

  private async alternarMic(): Promise<void> {
    if (this.grabando) {
      this.grabadorManual?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MIME_AUDIO();
      const trozos: Blob[] = [];
      this.grabadorManual = new MediaRecorder(stream, { mimeType: mime });
      this.grabadorManual.ondataavailable = e => trozos.push(e.data);
      this.grabadorManual.onstop = () => {
        stream.getTracks().forEach(p => p.stop());
        this.grabando = false;
        this.btnMic.removeClass('diario-grabando');
        const blob = new Blob(trozos, { type: mime });
        if (blob.size >= 2000) void this.transcribirYEnviar(blob, mime); // <2KB = clic accidental
      };
      this.grabadorManual.start();
      this.grabando = true;
      this.btnMic.addClass('diario-grabando');
    } catch (e) {
      this.burbuja('error', `${this.t().errorMic}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── manos libres: mic abierto + detección de pausa ────────────

  private manosPuedeEscuchar(): boolean {
    const sesion = this.plugin.sesion;
    return (
      this.manos.activo &&
      !this.cerrada &&
      this.modo === 'registrar' &&
      sesion?.fase === 'entrevista' &&
      !this.enviando &&
      !this.grabando &&
      this.audiosEnCola === 0
    );
  }

  private async manosActivar(): Promise<void> {
    const m = this.manos;
    try {
      m.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.burbuja('error', `${this.t().errorMic}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    m.contexto = new AudioContext();
    await m.contexto.resume();
    const fuente = m.contexto.createMediaStreamSource(m.stream);
    m.analizador = m.contexto.createAnalyser();
    m.analizador.fftSize = 1024;
    fuente.connect(m.analizador);
    m.activo = true;
    m.calibraciones = 0;
    m.graciaHasta = 0;
    this.btnManosLibres.setText(this.t().manosLibresSi);
    this.btnManosLibres.addClass('diario-activo');
    this.burbuja('sistema', this.t().manosLibresAviso);
  }

  private manosDesactivar(): void {
    const m = this.manos;
    if (!m.activo) return;
    m.activo = false;
    if (m.escuchando) this.manosPararGrabacion(false);
    m.stream?.getTracks().forEach(p => p.stop());
    void m.contexto?.close().catch(() => {});
    m.stream = m.contexto = m.analizador = null;
    this.btnManosLibres.setText(this.t().manosLibresNo);
    this.btnManosLibres.removeClass('diario-activo');
    this.btnMic.removeClass('diario-escuchando');
  }

  private manosEmpezarGrabacion(): void {
    const m = this.manos;
    if (!m.stream) return;
    m.trozos = [];
    m.grabador = new MediaRecorder(m.stream, { mimeType: MIME_AUDIO() });
    m.grabador.ondataavailable = e => m.trozos.push(e.data);
    m.grabador.start();
    m.escuchando = true;
    m.hablando = false;
    m.inicioEscucha = performance.now();
    this.btnMic.addClass('diario-escuchando');
  }

  private manosPararGrabacion(enviarAudio: boolean): void {
    const m = this.manos;
    if (!m.escuchando || !m.grabador) return;
    const grabador = m.grabador;
    const habloMs = m.ultimoSonido - m.primerSonido;
    m.escuchando = false;
    m.grabador = null;
    this.btnMic.removeClass('diario-escuchando');
    grabador.onstop = () => {
      const blob = new Blob(m.trozos, { type: grabador.mimeType });
      if (enviarAudio && blob.size > 3000 && habloMs >= HABLA_MINIMA_MS) {
        void this.transcribirYEnviar(blob, grabador.mimeType);
      }
    };
    grabador.stop();
  }

  private manosRms(): number {
    const m = this.manos;
    if (!m.analizador) return 0;
    const datos = new Uint8Array(m.analizador.fftSize);
    m.analizador.getByteTimeDomainData(datos);
    let suma = 0;
    for (const v of datos) {
      const d = (v - 128) / 128;
      suma += d * d;
    }
    return Math.sqrt(suma / datos.length);
  }

  private manosTick(): void {
    const m = this.manos;
    if (!m.activo) return;

    if (!this.manosPuedeEscuchar()) {
      if (m.escuchando) this.manosPararGrabacion(false); // el TTS o un envío interrumpió: descartar
      m.graciaHasta = performance.now() + 500;
      return;
    }
    if (!m.escuchando) {
      if (performance.now() < m.graciaHasta) return;
      this.manosEmpezarGrabacion();
      return;
    }

    const rms = this.manosRms();
    const ahora = performance.now();

    if (m.calibraciones < 8 && !m.hablando) {
      m.ruidoBase = m.ruidoBase * 0.7 + rms * 0.3;
      m.calibraciones++;
    }
    const umbral = Math.max(UMBRAL_MINIMO, m.ruidoBase * 3);

    if (rms > umbral) {
      if (!m.hablando) {
        m.hablando = true;
        m.primerSonido = ahora;
      }
      m.ultimoSonido = ahora;
      return;
    }

    if (m.hablando && ahora - m.ultimoSonido > SILENCIO_MS) {
      this.manosPararGrabacion(true);
      return;
    }
    if (!m.hablando && ahora - m.inicioEscucha > REINICIO_MS) {
      this.manosPararGrabacion(false); // no acumular minutos de silencio
    }
  }

  // ── adjuntos: fotos y documentos ──────────────────────────────

  private async adjuntarArchivos(): Promise<void> {
    const sesion = this.plugin.sesion;
    const archivos = [...(this.archivoEl.files ?? [])].slice(0, 5);
    this.archivoEl.value = '';
    if (!sesion || sesion.fase !== 'entrevista') return;
    for (const archivo of archivos) {
      const chip = this.chipsEl.createSpan({ cls: 'diario-chip-adj', text: `⏳ ${archivo.name}` });
      try {
        const datos = Buffer.from(await archivo.arrayBuffer());
        let textoExtraido: string | undefined;
        const nombre = archivo.name.toLowerCase();
        if (nombre.endsWith('.pdf')) {
          textoExtraido = await this.plugin.voz().extraerPdf(datos.buffer.slice(datos.byteOffset, datos.byteOffset + datos.byteLength));
        } else if (nombre.endsWith('.txt') || nombre.endsWith('.md')) {
          textoExtraido = datos.toString('utf8');
        }
        const guardado = await sesion.guardarAdjunto(archivo.name, datos, textoExtraido);
        const leido = Boolean(textoExtraido) || EXT_IMAGEN.test(guardado.nombre);
        chip.setText(`${guardado.tipo === 'imagen' ? '🖼️' : '📄'} ${guardado.nombre}${leido ? '' : this.t().adjuntoSoloEnlace}`);
      } catch (e) {
        chip.remove();
        this.burbuja('error', `${plantilla(this.t().adjuntoError, { nombre: archivo.name })}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private hayAdjuntos(): boolean {
    return this.chipsEl.childElementCount > 0;
  }

  // ── pestaña consultar: preguntas a la memoria RAG ─────────────

  private cambiarModo(modo: 'registrar' | 'consultar'): void {
    if (this.modo === modo) return;
    this.modo = modo;
    const t = this.t();
    const consultar = modo === 'consultar';
    this.tabRegistrar.toggleClass('diario-pestana-activa', !consultar);
    this.tabConsultar.toggleClass('diario-pestana-activa', consultar);
    if (consultar) {
      this.manosDesactivar(); // manos libres es solo de la entrevista
      this.chatEl.hide();
      this.consultaChatEl.show();
      this.btnTerminar.hide();
      this.btnManosLibres.hide();
      this.btnAdjuntar.hide();
      this.entradaEl.placeholder = t.consultaPlaceholder;
      if (!this.consultaChatEl.childElementCount) this.abrirConsulta();
      this.entradaEl.disabled = this.consultando;
      this.btnEnviar.disabled = this.consultando;
      this.btnMic.disabled = this.consultando || !this.saludVoz.stt;
      if (!this.consultando) this.entradaEl.focus();
    } else {
      this.chatEl.show();
      this.consultaChatEl.hide();
      this.btnTerminar.show();
      this.btnManosLibres.show();
      this.btnAdjuntar.show();
      this.entradaEl.placeholder = t.placeholder;
      this.habilitar(this.plugin.sesion?.fase === 'entrevista' && !this.enviando);
    }
    this.bajarScroll(consultar ? this.consultaChatEl : this.chatEl);
  }

  private abrirConsulta(): void {
    const rag = this.plugin.rag;
    if (!rag?.activo) {
      this.burbuja('sistema', this.t().consultaSinMemoria, this.consultaChatEl);
      return;
    }
    this.burbuja('asistente', this.t().consultaIntro, this.consultaChatEl);
  }

  private async enviarConsulta(texto: string): Promise<void> {
    const limpio = texto.trim();
    if (!limpio || this.consultando) return;
    const t = this.t();
    const rag = this.plugin.rag;
    if (!rag?.activo) {
      this.burbuja('sistema', t.consultaSinMemoria, this.consultaChatEl);
      return;
    }
    this.entradaEl.value = '';
    this.entradaEl.setCssStyles({ height: 'auto' });
    this.burbuja('usuario', limpio, this.consultaChatEl);
    this.consultando = true;
    this.entradaEl.disabled = true;
    this.btnEnviar.disabled = true;
    this.btnMic.disabled = true;
    this.mostrarIndicador(t.pensando, this.consultaChatEl);
    try {
      this.consulta ??= new ConsultaDiario(this.plugin.configActual(), rag);
      const { respuesta, fuentes } = await this.consulta.preguntar(limpio);
      this.quitarIndicador();
      this.burbuja('asistente', respuesta, this.consultaChatEl);
      if (fuentes.length) this.pintarFuentes(fuentes);
      this.hablar(respuesta);
    } catch (e) {
      this.quitarIndicador();
      this.burbuja('error', e instanceof Error ? e.message : String(e), this.consultaChatEl);
    } finally {
      this.consultando = false;
      if (this.modo === 'consultar') {
        this.entradaEl.disabled = false;
        this.btnEnviar.disabled = false;
        this.btnMic.disabled = !this.saludVoz.stt;
        this.entradaEl.focus();
      }
    }
  }

  // Chips clicables bajo la respuesta: cada fuente abre su nota en Obsidian
  // (en pestaña nueva, para no reemplazar el diario).
  private pintarFuentes(fuentes: ResultadoRag[]): void {
    const fila = this.consultaChatEl.createDiv({ cls: 'diario-fuentes' });
    fila.createSpan({ cls: 'diario-fuentes-etiqueta', text: this.t().consultaFuentes });
    const vistas = new Set<string>();
    for (const f of fuentes) {
      if (vistas.has(f.ruta)) continue;
      vistas.add(f.ruta);
      const chip = fila.createEl('button', { cls: 'diario-fuente', text: f.ruta.replace(/\.md$/, '') });
      chip.setAttr('title', `${f.seccion || '§'} · ${f.score.toFixed(2)}`);
      this.registerDomEvent(chip, 'click', () => void this.app.workspace.openLinkText(f.ruta, '', true));
    }
    this.bajarScroll(this.consultaChatEl);
  }

  // ── racha 🔥 + energía ────────────────────────────────────────

  private pintarRacha(): void {
    const sesion = this.plugin.sesion;
    const vault = this.plugin.rutaVault();
    if (!sesion || !vault) return;
    const noches = racha(vault, sesion.fecha, sesion.idiomaVault);
    if (noches < 1) return;
    this.rachaEl.empty();
    this.rachaEl.show();
    this.rachaEl.setAttr('title', plantilla(this.t().rachaTitulo, { n: noches }));
    this.rachaEl.createSpan({ text: `🔥 ${noches}` });
    const barras = this.rachaEl.createSpan({ cls: 'diario-barras' });
    for (const dia of energiasRecientes(vault, sesion.fecha, sesion.idiomaVault)) {
      const barra = barras.createEl('i', { cls: dia.nivel ? '' : 'diario-barra-vacia' });
      barra.setCssStyles({ height: dia.nivel ? `${3 + dia.nivel * 3}px` : '2px' });
      barra.setAttr('title', dia.fecha);
    }
  }

  // ── flujo de la sesión ────────────────────────────────────────

  async iniciarSesion(): Promise<void> {
    this.chatEl.empty();
    this.chipsEl.empty();
    this.consultaChatEl.empty();
    this.consulta = null;
    this.rachaEl.hide();
    this.habilitar(false);
    this.mostrarIndicador(this.t().preparando);
    try {
      const sesion = this.plugin.nuevaSesion();
      const saludo = await sesion.saludar();
      this.quitarIndicador();
      this.fechaEl.setText(sesion.fecha);
      this.pintarRacha();
      this.burbuja('asistente', saludo);
      this.hablar(saludo);
      this.habilitar(true);
      if (this.modo === 'consultar') this.abrirConsulta();
    } catch (e) {
      this.quitarIndicador();
      await this.tarjetaPrimerArranque(e instanceof Error ? e.message : String(e));
    }
  }

  // Cuando la sesión no arranca, casi siempre es el entorno: sin Ollama o
  // sin el modelo. Una tarjeta que dice qué falta, no un stack trace.
  private async tarjetaPrimerArranque(mensajeError: string): Promise<void> {
    const t = this.t();
    const { ollamaUrl, modelo } = this.plugin.ajustes;
    const st = await estadoOllama(ollamaUrl, modelo);

    const tarjeta = this.chatEl.createDiv({ cls: 'diario-tarjeta' });
    tarjeta.createEl('h3', { text: t.estadoTitulo });
    const acciones = tarjeta.createDiv({ cls: 'diario-tarjeta-acciones' });

    if (!st.ollama) {
      tarjeta.createDiv({ cls: 'diario-tarjeta-texto', text: t.estadoSinOllama });
      const enlace = acciones.createEl('a', { href: 'https://ollama.com/download' });
      enlace.createEl('button', { cls: 'diario-boton diario-primario', text: t.estadoDescargarOllama });
    } else if (!st.modeloOk) {
      tarjeta.createDiv({ cls: 'diario-tarjeta-texto', text: plantilla(t.estadoSinModelo, { modelo }) });
      tarjeta.createEl('code', { cls: 'diario-codigo', text: `ollama pull ${modelo}` });
    } else {
      tarjeta.createDiv({ cls: 'diario-tarjeta-texto', text: `${t.errorIniciar}: ${mensajeError}` });
    }

    const reintentar = acciones.createEl('button', { cls: 'diario-boton', text: t.estadoReintentar });
    this.registerDomEvent(reintentar, 'click', () => void this.iniciarSesion());
    tarjeta.appendChild(acciones);
    this.bajarScroll();
  }

  private async enviar(texto: string): Promise<void> {
    if (this.modo === 'consultar') return this.enviarConsulta(texto);
    const sesion = this.plugin.sesion;
    let limpio = texto.trim();
    if (!sesion || sesion.fase !== 'entrevista' || this.enviando) return;
    if (!limpio && this.hayAdjuntos()) limpio = this.t().teComparto;
    if (!limpio) return;
    this.entradaEl.value = '';
    this.entradaEl.setCssStyles({ height: 'auto' });
    const adjuntosTexto = [...this.chipsEl.children].map(c => c.textContent).join('  ');
    this.chipsEl.empty();
    this.burbuja('usuario', adjuntosTexto ? `${adjuntosTexto}\n${limpio}` : limpio);
    this.enviando = true;
    this.habilitar(false);
    this.mostrarIndicador(this.t().pensando);
    try {
      const respuesta = await sesion.responder(limpio);
      this.quitarIndicador();
      if (respuesta === null) {
        this.mostrarIndicador(this.t().analizando);
        const { plan } = await sesion.finalizar();
        this.quitarIndicador();
        this.mostrarPlan(plan);
      } else {
        this.burbuja('asistente', respuesta);
        this.hablar(respuesta);
        this.habilitar(true);
      }
    } catch (e) {
      this.quitarIndicador();
      this.burbuja('error', e instanceof Error ? e.message : String(e));
      this.habilitar(true);
    } finally {
      this.enviando = false;
    }
  }

  private async terminar(): Promise<void> {
    const sesion = this.plugin.sesion;
    if (!sesion || sesion.fase !== 'entrevista' || this.enviando) return;
    if (!sesion.haHabladoElUsuario()) {
      this.plugin.sesion = null;
      this.burbuja('sistema', this.t().sesionVacia);
      this.botonNuevaSesion();
      return;
    }
    this.enviando = true;
    this.habilitar(false);
    this.mostrarIndicador(this.t().analizando);
    try {
      const { plan } = await sesion.finalizar();
      this.quitarIndicador();
      this.mostrarPlan(plan);
    } catch (e) {
      this.quitarIndicador();
      this.burbuja('error', e instanceof Error ? e.message : String(e));
      this.habilitar(true);
    } finally {
      this.enviando = false;
    }
  }

  // El plan llega como [{id, texto}]: checkbox por item, lo desmarcado se
  // excluye al aplicar — control total antes de escribir una sola línea.
  private mostrarPlan(plan: ItemPlan[]): void {
    const t = this.t();
    this.manosDesactivar();
    const tarjeta = this.chatEl.createDiv({ cls: 'diario-tarjeta' });
    tarjeta.createEl('h3', { text: t.planTitulo });
    const lista = tarjeta.createEl('ul', { cls: 'diario-plan' });
    const cajas: HTMLInputElement[] = [];
    for (const item of plan) {
      const li = lista.createEl('li');
      const etiqueta = li.createEl('label');
      const caja = etiqueta.createEl('input', { type: 'checkbox' });
      caja.checked = true;
      caja.dataset.id = item.id;
      const texto = etiqueta.createSpan({ text: item.texto });
      this.registerDomEvent(caja, 'change', () => texto.toggleClass('diario-fuera', !caja.checked));
      cajas.push(caja);
    }
    const acciones = tarjeta.createDiv({ cls: 'diario-tarjeta-acciones' });
    const btnAplicar = acciones.createEl('button', { cls: 'diario-boton diario-primario', text: t.planAplicar });
    const btnDescartar = acciones.createEl('button', { cls: 'diario-boton', text: t.planDescartar });
    this.bajarScroll();
    this.hablar(t.planVozIntro);

    this.registerDomEvent(btnAplicar, 'click', () => {
      const excluir = cajas.filter(c => !c.checked).map(c => c.dataset.id ?? '');
      btnAplicar.disabled = true;
      btnDescartar.disabled = true;
      void this.aplicar(excluir);
    });
    this.registerDomEvent(btnDescartar, 'click', () => {
      btnAplicar.disabled = true;
      btnDescartar.disabled = true;
      this.plugin.sesion = null;
      this.burbuja('sistema', t.descartado);
      this.botonNuevaSesion();
    });
  }

  private async aplicar(excluir: string[]): Promise<void> {
    const sesion = this.plugin.sesion;
    const t = this.t();
    if (!sesion || sesion.fase !== 'plan') return;
    this.mostrarIndicador(t.escribiendo);
    try {
      const { resultado, hash, totales } = sesion.aplicar(excluir);
      this.quitarIndicador();

      const tarjeta = this.chatEl.createDiv({ cls: 'diario-tarjeta' });
      tarjeta.createEl('h3', { text: t.guardadoTitulo });
      const lista = tarjeta.createEl('ul', { cls: 'diario-resultado' });
      for (const archivo of resultado.archivos) {
        lista.createEl('li', { cls: 'diario-hecho', text: `${archivo.ruta} · ${archivo.detalles.join(' · ')}` });
      }
      for (const omitido of resultado.omitidos) {
        lista.createEl('li', { cls: 'diario-omitido', text: omitido });
      }
      tarjeta.createDiv({ cls: 'diario-comentario', text: `${totales}${hash ? ` · commit ${hash}` : ''}` });

      if (hash) {
        const acciones = tarjeta.createDiv({ cls: 'diario-tarjeta-acciones' });
        const btnDeshacer = acciones.createEl('button', { cls: 'diario-boton', text: t.deshacer });
        this.registerDomEvent(btnDeshacer, 'click', () => {
          btnDeshacer.disabled = true;
          const r = sesion.deshacer();
          if (r.ok) {
            this.burbuja('sistema', t.deshecho);
            btnDeshacer.remove();
          } else {
            btnDeshacer.disabled = false;
            this.burbuja('error', r.detalle);
          }
        });
      }

      this.burbuja('asistente', t.guardadoDespedida);
      this.hablar(t.guardadoDespedidaVoz);
      this.botonNuevaSesion();
      void this.plugin.refrescarRag();
    } catch (e) {
      this.quitarIndicador();
      this.burbuja('error', e instanceof Error ? e.message : String(e));
    }
  }

  private botonNuevaSesion(): void {
    this.manosDesactivar();
    const div = this.chatEl.createDiv({ cls: 'diario-burbuja diario-sistema' });
    const btn = div.createEl('button', { cls: 'diario-boton', text: this.t().nuevaSesion });
    this.registerDomEvent(btn, 'click', () => void this.iniciarSesion());
    this.bajarScroll();
  }
}
