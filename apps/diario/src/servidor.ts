// Servidor local de la UI del diario: sirve la página, expone la sesión de
// entrevista como API y hace proxy al sidecar de voz (Whisper STT + Kokoro
// TTS). Solo escucha en 127.0.0.1 — nada sale de tu máquina.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { cargarConfig, esStandalone, guardarIdioma, htmlEmbebido, raizApp, rutaConfig } from './config.js';
import { SesionDiario } from './sesion.js';
import { esIdioma, TEXTOS_UI, type Idioma } from './idioma.js';
import { energiasRecientes, racha } from './racha.js';
import { Rag } from './rag.js';
import { hoyISO, idiomaDelVault } from './vault.js';

const args = process.argv.slice(2);
const valorDe = (bandera: string) => {
  const i = args.indexOf(bandera);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};

const cfg = cargarConfig();
if (valorDe('--vault')) cfg.vault = resolve(process.cwd(), valorDe('--vault')!);
if (esIdioma(valorDe('--idioma'))) cfg.idioma = valorDe('--idioma') as Idioma;
const PUERTO = Number(valorDe('--puerto')) || cfg.ui?.puerto || 4242;
const RUTA_HTML = resolve(raizApp, 'ui', 'index.html');

const gris = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cian = (s: string) => `\x1b[36m${s}\x1b[0m`;

let sesion: SesionDiario | null = null;
let procesoVoz: ChildProcess | null = null;

// Memoria de largo plazo (RAG): se indexa al arrancar y tras cada sesión
// aplicada. Si el modelo de embeddings no está, se apaga sola.
const rag = new Rag(cfg.vault, cfg);

async function refrescarRag(motivo: string): Promise<void> {
  const r = await rag.reindexar();
  if (rag.activo && r.embebidas) {
    console.log(gris(`  [rag] ${motivo}: ${r.embebidas} nota(s) embebida(s) · ${r.total} en el índice`));
  }
}

// ── Sidecar de voz ──────────────────────────────────────────────

async function vozDisponible(): Promise<{ stt: boolean; kokoro: boolean; apagado?: boolean }> {
  if (!cfg.voz?.activada) return { stt: false, kokoro: false, apagado: true };
  try {
    const res = await fetch(`${cfg.voz.url}/salud`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()) as { stt: boolean; kokoro: boolean };
  } catch {
    return { stt: false, kokoro: false, apagado: true };
  }
}

async function iniciarVoz(): Promise<void> {
  const voz = cfg.voz;
  if (!voz?.activada || !voz.autoIniciar) return;
  const salud = await vozDisponible();
  if (!salud.apagado) {
    console.log(gris('  [voz] sidecar ya estaba corriendo'));
    return;
  }
  if (!existsSync(voz.python)) {
    console.log(gris(`  [voz] no encontré python de chatterbox en ${voz.python} — modo solo texto`));
    return;
  }
  const script = resolve(raizApp, voz.script);
  console.log(gris(`  [voz] iniciando sidecar (los modelos tardan ~20-30s en cargar)…`));
  procesoVoz = spawn(voz.python, [script, String(voz.puerto)], {
    cwd: voz.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reenviar = (datos: Buffer) => {
    for (const linea of datos.toString().split('\n')) {
      if (linea.trim()) console.log(gris(`  ${linea.trim()}`));
    }
  };
  procesoVoz.stdout?.on('data', reenviar);
  procesoVoz.stderr?.on('data', reenviar);
  procesoVoz.on('exit', codigo => console.log(gris(`  [voz] sidecar terminó (código ${codigo})`)));
}

function apagarVoz(): void {
  if (procesoVoz && !procesoVoz.killed) procesoVoz.kill();
}
process.on('exit', apagarVoz);
process.on('SIGINT', () => {
  apagarVoz();
  process.exit(0);
});

// ── Utilidades HTTP ─────────────────────────────────────────────

function json(res: ServerResponse, codigo: number, cuerpo: unknown): void {
  const datos = JSON.stringify(cuerpo);
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8' });
  res.end(datos);
}

function leerCuerpo(req: IncomingMessage, limite = 30 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    const trozos: Buffer[] = [];
    let total = 0;
    req.on('data', (t: Buffer) => {
      total += t.length;
      if (total > limite) {
        rechazar(new Error('cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      trozos.push(t);
    });
    req.on('end', () => resolver(Buffer.concat(trozos)));
    req.on('error', rechazar);
  });
}

async function leerJson<T>(req: IncomingMessage): Promise<T> {
  const cuerpo = await leerCuerpo(req);
  if (!cuerpo.length) return {} as T;
  return JSON.parse(cuerpo.toString('utf8')) as T;
}

// La página se sirve con los textos del idioma actual ya inyectados: la UI
// no tiene strings propios y no hay parpadeo de idioma al cargar. En el
// standalone el HTML viaja embebido dentro del ejecutable (asset de SEA).
export function cargarHtml(): string {
  return htmlEmbebido() ?? readFileSync(RUTA_HTML, 'utf8');
}

function paginaConIdioma(): string {
  const idioma = cfg.idioma ?? 'es';
  return cargarHtml().replace('"{{I18N}}"', JSON.stringify({ idioma, textos: TEXTOS_UI[idioma] }));
}

// ── Rutas ───────────────────────────────────────────────────────

async function manejar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [ruta, consultaCruda] = (req.url ?? '/').split('?');
  const consulta = new URLSearchParams(consultaCruda ?? '');
  const metodo = req.method ?? 'GET';

  if (metodo === 'GET' && (ruta === '/' || ruta === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(paginaConIdioma());
    return;
  }
  if (metodo === 'GET' && ruta === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (metodo === 'GET' && ruta === '/api/voz/salud') {
    json(res, 200, await vozDisponible());
    return;
  }

  // Estado del entorno para la pantalla de primer arranque del standalone:
  // ¿Ollama responde? ¿el modelo configurado ya está descargado?
  if (metodo === 'GET' && ruta === '/api/estado') {
    let ollama = false;
    let modelos: string[] = [];
    try {
      const r = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        ollama = true;
        const datos = (await r.json()) as { models?: { name: string }[] };
        modelos = (datos.models ?? []).map(m => m.name);
      }
    } catch {
      // sin Ollama: la UI muestra cómo instalarlo
    }
    const tieneModelo = (buscado: string) => modelos.some(m => m === buscado || m.startsWith(`${buscado}:`));
    json(res, 200, {
      ollama,
      modelos,
      modelo: cfg.modelo,
      modeloOk: ollama && tieneModelo(cfg.modelo),
      vault: cfg.vault,
      standalone: esStandalone,
      config: rutaConfig(),
    });
    return;
  }

  // Descarga el modelo configurado vía Ollama (puede tardar varios minutos;
  // la UI hace polling de /api/estado mientras tanto).
  if (metodo === 'POST' && ruta === '/api/modelo') {
    try {
      const r = await fetch(`${cfg.ollamaUrl}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.modelo, stream: false }),
      });
      if (!r.ok) {
        json(res, 502, { error: `Ollama respondió ${r.status}: ${await r.text()}` });
        return;
      }
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  // Cambia el idioma de la app (conversación + UI) y lo persiste. El
  // esquema de un vault existente no cambia: quedó fijado en .indice/idioma.
  if (metodo === 'POST' && ruta === '/api/idioma') {
    const { idioma } = await leerJson<{ idioma?: string }>(req);
    if (!esIdioma(idioma)) {
      json(res, 400, { error: 'idioma debe ser "es" o "en"' });
      return;
    }
    cfg.idioma = idioma;
    guardarIdioma(idioma);
    sesion = null; // la próxima sesión arranca en el idioma nuevo
    json(res, 200, { ok: true, idioma });
    return;
  }

  // Búsqueda semántica sobre el vault ("¿de qué hablé hace dos semanas?")
  if (metodo === 'GET' && ruta === '/api/buscar') {
    const q = consulta.get('q') ?? '';
    if (!q.trim()) {
      json(res, 400, { error: 'falta ?q=' });
      return;
    }
    const resultados = await rag.buscar(q, { k: Number(consulta.get('k')) || 5, min: 0.2 });
    json(res, 200, {
      activo: rag.activo,
      resultados: resultados.map(r => ({ ruta: r.ruta, seccion: r.seccion, score: Number(r.score.toFixed(3)), texto: r.texto.slice(0, 400) })),
    });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/sesion') {
    sesion = new SesionDiario(cfg, rag.activo ? rag : undefined);
    const saludo = await sesion.saludar();
    json(res, 200, {
      saludo,
      fecha: sesion.fecha,
      preguntasMax: cfg.preguntasMax,
      vozActivada: cfg.voz?.activada ?? false,
      idioma: sesion.idiomaUi,
      racha: racha(cfg.vault, sesion.fecha, sesion.idiomaVault),
      energias: energiasRecientes(cfg.vault, sesion.fecha, sesion.idiomaVault),
    });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/mensaje') {
    if (!sesion || sesion.fase !== 'entrevista') {
      json(res, 409, { error: 'No hay entrevista activa. Inicia una sesión.' });
      return;
    }
    const { texto } = await leerJson<{ texto: string }>(req);
    const limpio = (texto ?? '').trim();
    if (!limpio) {
      json(res, 400, { error: 'mensaje vacío' });
      return;
    }
    const respuesta = await sesion.responder(limpio);
    if (respuesta === null) {
      const { plan } = await sesion.finalizar();
      json(res, 200, { tipo: 'plan', plan });
      return;
    }
    json(res, 200, { tipo: 'pregunta', texto: respuesta });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/adjunto') {
    if (!sesion || sesion.fase !== 'entrevista') {
      json(res, 409, { error: 'No hay entrevista activa.' });
      return;
    }
    const nombre = consulta.get('nombre') ?? 'archivo';
    const datos = await leerCuerpo(req);
    if (!datos.length) {
      json(res, 400, { error: 'archivo vacío' });
      return;
    }

    // PDF: extraer texto vía el sidecar (PyMuPDF); txt/md: leer directo
    let textoExtraido: string | undefined;
    const extension = nombre.toLowerCase().split('.').pop() ?? '';
    if (extension === 'pdf' && cfg.voz?.activada) {
      try {
        const r = await fetch(`${cfg.voz.url}/extraer`, {
          method: 'POST',
          body: new Uint8Array(datos),
          signal: AbortSignal.timeout(20000),
        });
        if (r.ok) textoExtraido = ((await r.json()) as { texto?: string }).texto;
      } catch {
        // sin sidecar el PDF se adjunta igual, solo que el modelo no lo lee
      }
    } else if (extension === 'txt' || extension === 'md') {
      textoExtraido = datos.toString('utf8');
    }

    const guardado = await sesion.guardarAdjunto(nombre, datos, textoExtraido);
    json(res, 200, { ...guardado, leido: Boolean(textoExtraido) || guardado.tipo === 'imagen' });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/finalizar') {
    if (!sesion || sesion.fase !== 'entrevista') {
      json(res, 409, { error: 'No hay entrevista activa.' });
      return;
    }
    if (!sesion.haHabladoElUsuario()) {
      sesion = null;
      json(res, 200, { tipo: 'vacia' });
      return;
    }
    const { plan } = await sesion.finalizar();
    json(res, 200, { tipo: 'plan', plan });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/aplicar') {
    if (!sesion || sesion.fase !== 'plan') {
      json(res, 409, { error: 'No hay un plan pendiente de confirmar.' });
      return;
    }
    const { excluir } = await leerJson<{ excluir?: string[] }>(req);
    const { resultado, hash, totales } = sesion.aplicar(Array.isArray(excluir) ? excluir : []);
    json(res, 200, { archivos: resultado.archivos, omitidos: resultado.omitidos, hash, totales });
    void refrescarRag('sesión aplicada'); // el vault cambió: memoria al día
    return;
  }

  if (metodo === 'POST' && ruta === '/api/deshacer') {
    if (!sesion || sesion.fase !== 'aplicada') {
      json(res, 409, { error: 'No hay una sesión aplicada que deshacer.' });
      return;
    }
    const r = sesion.deshacer();
    if (!r.ok) {
      json(res, 409, { error: r.detalle });
      return;
    }
    json(res, 200, { ok: true });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/descartar') {
    sesion = null;
    json(res, 200, { ok: true });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/tts') {
    if (!cfg.voz?.activada) {
      json(res, 503, { error: 'voz desactivada' });
      return;
    }
    const cuerpo = await leerCuerpo(req);
    const respuesta = await fetch(`${cfg.voz.url}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(cuerpo),
    });
    if (!respuesta.ok) {
      json(res, respuesta.status, { error: `tts: ${respuesta.status}` });
      return;
    }
    const audio = Buffer.from(await respuesta.arrayBuffer());
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length });
    res.end(audio);
    return;
  }

  if (metodo === 'POST' && ruta === '/api/stt') {
    if (!cfg.voz?.activada) {
      json(res, 503, { error: 'voz desactivada' });
      return;
    }
    const cuerpo = await leerCuerpo(req);
    const respuesta = await fetch(`${cfg.voz.url}/stt?idioma=${cfg.idioma ?? 'es'}`, {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? 'application/octet-stream' },
      body: new Uint8Array(cuerpo),
    });
    const datos = await respuesta.text();
    res.writeHead(respuesta.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(datos);
    return;
  }

  json(res, 404, { error: `ruta desconocida: ${metodo} ${ruta}` });
}

const servidor = createServer((req, res) => {
  manejar(req, res).catch((e: unknown) => {
    const mensaje = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${req.method} ${req.url}: ${mensaje}`);
    if (!res.headersSent) json(res, 500, { error: mensaje });
  });
});

servidor.listen(PUERTO, '127.0.0.1', () => {
  const idiomaVault = idiomaDelVault(cfg.vault, cfg.idioma ?? 'es');
  console.log(`\n${cian('◆ diario ui')} — http://localhost:${PUERTO}`);
  console.log(gris(`  vault ${cfg.vault} (${idiomaVault}) · idioma ${cfg.idioma}`));
  console.log(gris(`  entrevista ${cfg.modelo} · extractor ${cfg.modeloExtractor} · memoria ${cfg.modeloEmbed}`));
  console.log(gris(`  racha: ${racha(cfg.vault, hoyISO(), idiomaVault)} noche(s)`));
  void iniciarVoz();
  void refrescarRag('arranque');
});
