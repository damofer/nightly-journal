// Memoria de largo plazo del diario (RAG local): embebe las notas del vault
// con Ollama (embeddinggemma por defecto) y permite buscar "de qué hablé
// hace dos semanas". El entrevistador la usa para preguntar cosas como
// "¿cómo siguió X?" con base en notas VIEJAS reales — nunca inventadas.
//
// El índice vive en .indice/rag.json (fuera del git del vault) y es
// incremental: solo se re-embebe lo que cambió (hash por nota).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import matter from 'gray-matter';
import type { Config } from './config.js';
import { postJson } from './red.js';

export interface ChunkRag {
  ruta: string; // relativa al vault, con /
  seccion: string;
  texto: string;
}

export interface ResultadoRag extends ChunkRag {
  score: number;
}

interface EntradaNota {
  hash: string;
  chunks: { seccion: string; texto: string; vector: number[] }[];
}

interface IndiceRag {
  version: number;
  modelo: string;
  notas: Record<string, EntradaNota>;
}

// súbela cuando cambie el troceo o los prefijos: fuerza re-embeber todo
const VERSION_INDICE = 3;

export type FnEmbed = (textos: string[]) => Promise<number[][]>;

// Adjuntos/Attachments SÍ se recorre: los .txt adjuntados y las notas
// compañeras "<doc>.pdf.md" (texto extraído) también son memoria.
const CARPETAS_EXCLUIDAS = new Set(['.git', '.obsidian', '.indice']);
const MAX_CHUNK = 1200;
// una sección larga se parte por párrafos: un chunk multi-tema se diluye y
// nada lo encuentra (medido: el Resumen diario con 5 temas puntuaba ~0.25
// entero vs ~0.4-0.5 por párrafo)
const SECCION_LARGA = 400;
const OBJETIVO_TROZO = 300;

// ── troceo ──────────────────────────────────────────────────────

// Una nota → chunks por sección "## X" (el cuerpo antes de la primera
// sección cuenta como sección ""). Determinista y sin modelo.
export function trocearNota(nombre: string, contenido: string): { seccion: string; texto: string }[] {
  const cuerpo = matter(contenido).content;
  const chunks: { seccion: string; texto: string }[] = [];
  let seccion = '';
  let lineas: string[] = [];
  const etiqueta = (s: string) => `${nombre}${s ? ` · ${s}` : ''}`;
  const cerrar = () => {
    const texto = lineas.join('\n').trim();
    lineas = [];
    if (!texto) return;
    if (texto.length <= SECCION_LARGA) {
      chunks.push({ seccion, texto: `${etiqueta(seccion)}\n${texto}`.slice(0, MAX_CHUNK) });
      return;
    }
    // sección larga: agrupa líneas/párrafos en trozos de ~OBJETIVO_TROZO
    let grupo: string[] = [];
    let largo = 0;
    const emitir = () => {
      const t = grupo.join('\n').trim();
      if (t) chunks.push({ seccion, texto: `${etiqueta(seccion)}\n${t}`.slice(0, MAX_CHUNK) });
      grupo = [];
      largo = 0;
    };
    for (const linea of texto.split('\n')) {
      if (largo && largo + linea.length > OBJETIVO_TROZO) emitir();
      grupo.push(linea);
      largo += linea.length + 1;
    }
    emitir();
  };
  for (const linea of cuerpo.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(linea);
    if (m) {
      cerrar();
      seccion = m[1];
    } else if (!/^#\s/.test(linea)) {
      lineas.push(linea);
    }
  }
  cerrar();
  return chunks;
}

export function coseno(a: number[], b: number[]): number {
  let punto = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    punto += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denominador = Math.sqrt(na) * Math.sqrt(nb);
  return denominador ? punto / denominador : 0;
}

// ── embeddings vía Ollama ───────────────────────────────────────

// Prefijos de tarea que recomienda embeddinggemma: mejoran la calidad de
// la recuperación (documento vs consulta se embeben distinto).
const prefijoDoc = (titulo: string, texto: string) => `title: ${titulo} | text: ${texto}`;
const prefijoConsulta = (texto: string) => `task: search result | query: ${texto}`;

function embedOllama(cfg: Config): FnEmbed {
  return async textos => {
    const res = await postJson(
      `${cfg.ollamaUrl}/api/embed`,
      { model: cfg.modeloEmbed, input: textos },
      { timeoutMs: 120000 }
    );
    if (res.status < 200 || res.status >= 300) throw new Error(`embed ${res.status}: ${res.texto}`);
    const datos = JSON.parse(res.texto) as { embeddings?: number[][] };
    if (!datos.embeddings) throw new Error('embed sin resultado');
    return datos.embeddings;
  };
}

// ── índice ──────────────────────────────────────────────────────

function rutaIndiceRag(vault: string): string {
  return join(vault, '.indice', 'rag.json');
}

function cargarIndiceRag(vault: string, modelo: string): IndiceRag {
  const ruta = rutaIndiceRag(vault);
  if (existsSync(ruta)) {
    try {
      const indice = JSON.parse(readFileSync(ruta, 'utf8')) as IndiceRag;
      // otro modelo u otro troceo → re-embeber todo
      if (indice.modelo === modelo && indice.version === VERSION_INDICE) return indice;
    } catch {
      // índice corrupto: se reconstruye
    }
  }
  return { version: VERSION_INDICE, modelo, notas: {} };
}

// Recursivo porque los adjuntos viven en Adjuntos/<fecha>/. Indexa .md y
// .txt; los binarios (pdf, imágenes) no — su texto entra por la compañera.
function listarNotas(vault: string): string[] {
  const rutas: string[] = [];
  const caminar = (dir: string) => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      if (entrada.isDirectory()) {
        if (!CARPETAS_EXCLUIDAS.has(entrada.name)) caminar(join(dir, entrada.name));
      } else if (/\.(md|txt)$/i.test(entrada.name)) {
        rutas.push(join(dir, entrada.name));
      }
    }
  };
  if (!existsSync(vault)) return rutas;
  for (const entrada of readdirSync(vault, { withFileTypes: true })) {
    if (entrada.isDirectory() && !CARPETAS_EXCLUIDAS.has(entrada.name)) caminar(join(vault, entrada.name));
  }
  return rutas;
}

export class Rag {
  private indice: IndiceRag;
  private embed: FnEmbed;
  activo = true; // se apaga solo si el modelo de embeddings no está

  constructor(
    private vault: string,
    private cfg: Config,
    embed?: FnEmbed
  ) {
    this.embed = embed ?? embedOllama(cfg);
    this.indice = cargarIndiceRag(vault, cfg.modeloEmbed ?? '');
  }

  // Re-embebe solo las notas nuevas o cambiadas. Nunca lanza: si el modelo
  // de embeddings falta, se apaga y el diario sigue sin memoria larga.
  async reindexar(): Promise<{ embebidas: number; total: number }> {
    if (!this.activo) return { embebidas: 0, total: 0 };
    const vivas = new Set<string>();
    let embebidas = 0;
    try {
      for (const rutaAbs of listarNotas(this.vault)) {
        const ruta = relative(this.vault, rutaAbs).replace(/\\/g, '/');
        vivas.add(ruta);
        const contenido = readFileSync(rutaAbs, 'utf8');
        const hash = createHash('sha1').update(contenido).digest('hex');
        if (this.indice.notas[ruta]?.hash === hash) continue;

        const nombre = ruta.replace(/\.md$/, '');
        const trozos = trocearNota(nombre, contenido);
        if (!trozos.length) {
          this.indice.notas[ruta] = { hash, chunks: [] };
          continue;
        }
        const vectores = await this.embed(trozos.map(t => prefijoDoc(nombre, t.texto)));
        this.indice.notas[ruta] = {
          hash,
          chunks: trozos.map((t, i) => ({ seccion: t.seccion, texto: t.texto, vector: vectores[i] ?? [] })),
        };
        embebidas++;
      }
      // notas borradas fuera del índice
      for (const ruta of Object.keys(this.indice.notas)) {
        if (!vivas.has(ruta)) delete this.indice.notas[ruta];
      }
      mkdirSync(join(this.vault, '.indice'), { recursive: true });
      writeFileSync(rutaIndiceRag(this.vault), JSON.stringify(this.indice), 'utf8');
    } catch (e) {
      this.activo = false;
      const mensaje = e instanceof Error ? e.message : String(e);
      console.log(`  [rag] memoria larga desactivada (${mensaje.slice(0, 120)})`);
      console.log(`  [rag] para activarla: ollama pull ${this.cfg.modeloEmbed}`);
    }
    return { embebidas, total: vivas.size };
  }

  async buscar(consulta: string, opciones?: { k?: number; min?: number; excluir?: RegExp }): Promise<ResultadoRag[]> {
    if (!this.activo || !consulta.trim()) return [];
    // umbral calibrado con embeddinggemma sobre el vault real: lo relevante
    // puntúa ~0.3-0.6 con chunks por párrafo; el ruido queda por debajo de ~0.2
    const { k = 3, min = 0.28, excluir } = opciones ?? {};
    try {
      const [vector] = await this.embed([prefijoConsulta(consulta)]);
      const resultados: ResultadoRag[] = [];
      for (const [ruta, nota] of Object.entries(this.indice.notas)) {
        if (excluir?.test(ruta)) continue;
        for (const chunk of nota.chunks) {
          const score = coseno(vector, chunk.vector);
          if (score >= min) resultados.push({ ruta, seccion: chunk.seccion, texto: chunk.texto, score });
        }
      }
      return resultados.sort((a, b) => b.score - a.score).slice(0, k);
    } catch {
      return []; // la búsqueda jamás rompe la entrevista
    }
  }

  notasIndexadas(): number {
    return Object.keys(this.indice.notas).length;
  }
}

// Etiqueta del corchete que ve el modelo. Para un adjunto la semántica va
// EN EL DATO ("documento adjuntado el X"), no en una regla del system que
// gemma3:4b ignora (medido: seguía diciendo "escribiste" de un PDF).
export function etiquetaRecuerdo(ruta: string, idioma: 'es' | 'en'): string {
  const sinMd = ruta.replace(/\.md$/, '');
  const m = /^(?:Adjuntos|Attachments)\/(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(sinMd);
  if (!m) return sinMd;
  const esImagen = /\.(jpe?g|png|gif|webp|bmp)$/i.test(m[2]);
  if (idioma === 'en') return `${esImagen ? 'image' : 'document'} "${m[2]}" attached on ${m[1]}`;
  return esImagen ? `imagen "${m[2]}" adjuntada el ${m[1]}` : `documento "${m[2]}" adjuntado el ${m[1]}`;
}

// Contexto listo para inyectar al entrevistador: recuerdos relevantes a lo
// que la persona acaba de decir, recortados y etiquetados por nota.
export function contextoRecuerdos(resultados: ResultadoRag[], idioma: 'es' | 'en', maxChars = 900): string | null {
  if (!resultados.length) return null;
  const lineas: string[] = [];
  let usado = 0;
  for (const r of resultados) {
    const linea = `- [${etiquetaRecuerdo(r.ruta, idioma)}] ${r.texto.split('\n').slice(1).join(' ').slice(0, 300)}`;
    if (usado + linea.length > maxChars) break;
    lineas.push(linea);
    usado += linea.length;
  }
  if (!lineas.length) return null;
  // afirmativo y con ejemplo: la recuperación ya pasó el umbral de
  // similitud, así que el recuerdo ES relevante — a un modelo 4b un
  // "úsalo si acaso" lo invita a ignorarlo (medido)
  const encabezado =
    idioma === 'en'
      ? 'Memories from THIS PERSON\'S journal (old notes they wrote; the [bracket] is the note and its date) directly related to what they just said. Two ways to use them: (1) if they MENTIONED something related, connect your question — e.g. memory "[Journal/2026-07-02] they\'re pulling my tooth at the end of the month" + they mention mouth pain → GOOD question: "Is this the tooth you said they were going to pull?". (2) if they ASKED about their own past and the answer is here, ANSWER it citing the note\'s date — e.g. they ask "when are they pulling it?" → GOOD reply: "In your July 2nd note you wrote they\'re pulling it at the end of the month. Did you book the appointment?". Use the real date from the bracket — don\'t say "yesterday" unless the note is from yesterday. Quote only what the memories say — never invent details:'
      : 'Recuerdos del diario de esta persona (notas VIEJAS que ella escribió; el [corchete] es la nota y su fecha) directamente relacionados con lo que acaba de decir. Dos maneras de usarlos: (1) si MENCIONÓ algo relacionado, conecta tu pregunta — ej. recuerdo "[Diario/2026-07-02] me van a sacar la muela a fin de mes" + menciona dolor de boca → BUENA pregunta: "¿es la muela que dijiste que te iban a sacar?". (2) si PREGUNTÓ por su propio pasado y la respuesta está aquí, RESPÓNDELE citando la fecha de la nota — ej. pregunta "¿cuándo me la sacan?" → BUENA respuesta: "En tu nota del 2 de julio escribiste que te la sacan a fin de mes. ¿Ya agendaste la cita?". Usa la fecha real del corchete — no digas "ayer" salvo que la nota sea de ayer. Cita solo lo que digan los recuerdos — nunca inventes detalles:';
  return `${encabezado}\n${lineas.join('\n')}`;
}
