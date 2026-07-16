// Sesión de diario reutilizable (la usa el servidor de la UI; el CLI de
// index.ts mantiene su propio loop de consola). Fases:
// entrevista → plan (extracción lista, esperando confirmación) → aplicada.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { Config } from './config.js';
import { conversar, extraerEstructurado, type Mensaje } from './ollama.js';
import { ESQUEMA_EXTRACCION, type Extraccion } from './esquema.js';
import { construirContexto, sistemaEntrevista, sistemaExtractor, type Contexto } from './entrevistador.js';
import {
  aplicarAdjuntos,
  aplicarExtraccion,
  describirPlan,
  filtrarExtraccion,
  type Adjunto,
  type ItemPlan,
  type ResultadoAplicacion,
} from './aplicador.js';
import { normalizarExtraccion } from './normalizador.js';
import { cargarIndice } from './entidades.js';
import { contextoRecuerdos, type Rag } from './rag.js';
import { TEXTOS_PLAN, type Idioma } from './idioma.js';
import { asegurarVault, commitVault, dirAdjuntos, hoyISO, idiomaDelVault, nombreSeguro, revertirCommit } from './vault.js';

const EXTENSIONES_IMAGEN = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

interface AdjuntoPendiente {
  nombre: string;
  tipo: 'imagen' | 'documento';
  b64?: string;
  extracto?: string;
}

export type FaseSesion = 'entrevista' | 'analizando' | 'plan' | 'aplicada';

export const PREGUNTAS_CIERRE: Record<Idioma, string> = {
  es: '¿Hay algo más que quieras dejar registrado hoy? Si no, dime "nada más" y cierro el día.',
  en: 'Is there anything else you want to leave on record today? If not, just say "nothing else" and I\'ll close the day.',
};

const NUDGE_CIERRE: Record<Idioma, string> = {
  es: 'La persona sigue contando cosas. Reacciona en una frase corta y pregunta si hay algo más que quiera dejar registrado hoy.',
  en: 'The person keeps sharing things. React in one short sentence and ask if there is anything else they want to leave on record today.',
};

// Cuando la persona PREGUNTA (no cuenta), el turno cambia: primero se
// responde con los recuerdos, después se sigue entrevistando. A gemma3:4b
// hay que decírselo en el turno — la regla general del system se la salta.
const NUDGE_RESPONDER: Record<Idioma, string> = {
  es: 'ATENCIÓN: la persona te acaba de hacer una PREGUNTA sobre su pasado y los recuerdos de arriba contienen la respuesta. En este turno está PROHIBIDO responder solo con otra pregunta. Tu respuesta debe seguir EXACTAMENTE este formato: "En tu nota del <fecha del corchete> escribiste que <el dato del recuerdo>. <una pregunta corta>". Copia el dato tal como está en el recuerdo, sin inventar nada.',
  en: 'ATTENTION: the person just ASKED about their past and the memories above contain the answer. This turn it is FORBIDDEN to reply with only another question. Your reply must follow EXACTLY this format: "In your <date from the bracket> note you wrote that <the fact from the memory>. <one short question>". Copy the fact as it appears in the memory, inventing nothing.',
};

// Descripción de una imagen adjuntada, para persistirla como nota compañera
// (la imagen en sí no es indexable por la memoria RAG).
const PROMPT_IMAGEN: Record<Idioma, string> = {
  es: 'Describe esta imagen en 2 a 4 frases para el archivo del diario personal de la persona: menciona lo concreto que se ve (texto visible, personas, lugares, objetos, cifras). Sin opiniones ni interpretaciones largas. Responde SOLO con la descripción, sin preámbulos.',
  en: "Describe this image in 2 to 4 sentences for this person's personal journal archive: mention the concrete things visible (visible text, people, places, objects, figures). No opinions or long interpretations. Reply ONLY with the description, no preamble.",
};

// gemma3 a veces antepone "Aquí tienes una descripción:" pese al prompt —
// una primera línea corta que termina en ":" se recorta determinista.
export function sinPreambulo(texto: string): string {
  return texto.trim().replace(/^[^\n]{0,80}:\s*\n+/, '');
}

// gemma3 a veces REPITE en su respuesta los bloques internos que se le
// inyectan como system intercalado (recuerdos del RAG, nudges): la plantilla
// de chat de los modelos pequeños los trata como texto a continuar (visto en
// vivo: el bloque de recuerdos completo apareció en el chat). Las reglas de
// prompt no lo evitan — la guarda determinista sí: se corta la respuesta
// donde asome cualquier bloque inyectado o una línea con el formato de los
// recuerdos ("- [nota] … ([[fecha]])"); si no queda nada, pregunta neutra.
export function sinFugaDeContexto(respuesta: string, inyectados: string[], idioma: Idioma): string {
  let corte = respuesta.length;
  for (const bloque of inyectados) {
    const firma = bloque.slice(0, 30);
    const i = firma ? respuesta.indexOf(firma) : -1;
    if (i !== -1 && i < corte) corte = i;
  }
  const bala = /^- \[[^\]\n]+\] .*\(\[\[/m.exec(respuesta);
  if (bala && bala.index < corte) corte = bala.index;
  const limpia = respuesta.slice(0, corte).trim();
  if (limpia) return limpia;
  return idioma === 'en' ? 'What else would you like to tell me about your day?' : '¿Qué más quieres contarme de tu día?';
}

// La persona preguntó pero el diario NO tiene nada suficientemente parecido:
// honestidad en vez de conexiones forzadas (sin adjuntar recuerdos débiles).
const NUDGE_SIN_REGISTRO: Record<Idioma, string> = {
  es: 'La persona te hizo una pregunta. Si es sobre su propio pasado, dile honestamente que no lo tienes registrado en el diario — NO inventes ni adivines. Si es otro tipo de pregunta, respóndela en una frase sin inventar nada. Después sigue la entrevista con UNA pregunta corta.',
  en: 'The person asked you a question. If it is about their own past, honestly tell them you don\'t have it on record in the journal — do NOT invent or guess. If it is another kind of question, answer it in one sentence without making anything up. Then continue the interview with ONE short question.',
};

// ¿El mensaje es una pregunta (pide un dato) en vez de contar el día?
export function esPregunta(texto: string): boolean {
  const n = texto.trim().toLowerCase();
  if (n.includes('?')) return true;
  return /^(cu[aá]ndo|qu[eé] |qui[eé]n|d[oó]nde|c[oó]mo|cu[aá]nto|recuerdas|te dije|te cont[eé]|when|what |who |where|how |did i|do i|have i|remember)/.test(n);
}

// ¿La respuesta significa "no, ya no hay más"? Heurística deliberadamente
// simple y bilingüe: frases de cierre solo cuentan en respuestas cortas —
// "nada más quiero agregar que..." (larga) sí trae contenido y NO debe cerrar.
export function esNegativa(texto: string): boolean {
  const n = texto.toLowerCase().replace(/[.,;:!¡¿?…"'’]/g, ' ').replace(/\s+/g, ' ').trim();
  if (
    n.length <= 40 &&
    /(nada mas|nada más|eso es todo|seria todo|sería todo|es todo por hoy|no tengo nada|asi esta bien|así está bien|nothing else|nothing more|that s all|that is all|that s it|that would be all|i m done|im done|we re done|all for today)/.test(n)
  ) {
    return true;
  }
  return (
    n.length <= 30 &&
    /^(pues |bueno |mmm |eh |well |um |uh |hmm |yeah |ok )*(no|nada|ya|listo|ok|dale|cierra|cerremos|nope|nah|done|nothing|close)( |$)/.test(n)
  );
}

export class SesionDiario {
  readonly fecha: string;
  readonly ctx: Contexto;
  readonly idiomaUi: Idioma;
  readonly idiomaVault: Idioma;
  fase: FaseSesion = 'entrevista';
  private mensajes: Mensaje[] = [];
  private respuestas = 0;
  private extraccion: Extraccion | null = null;
  plan: ItemPlan[] = [];
  private adjuntosPendientes: AdjuntoPendiente[] = [];
  private adjuntosSesion: Adjunto[] = [];
  private enCierre = false;
  private hashAplicado: string | null = null;

  constructor(
    private cfg: Config,
    private rag?: Rag
  ) {
    this.idiomaUi = cfg.idioma ?? 'es';
    this.idiomaVault = idiomaDelVault(cfg.vault, this.idiomaUi);
    asegurarVault(cfg.vault, this.idiomaVault, cfg.git ?? true);
    this.fecha = hoyISO();
    this.ctx = construirContexto(cfg.vault, this.fecha, this.idiomaVault);
  }

  async saludar(): Promise<string> {
    this.mensajes = [{ role: 'system', content: sistemaEntrevista(this.ctx, this.cfg.preguntasMax, this.idiomaUi) }];
    const saludo = await conversar(this.cfg, this.mensajes);
    this.mensajes.push({ role: 'assistant', content: saludo });
    return saludo;
  }

  haHabladoElUsuario(): boolean {
    return this.mensajes.some(m => m.role === 'user');
  }

  // Guarda un archivo en vault/Adjuntos/<fecha>/ y lo deja pendiente para
  // acompañar el próximo mensaje del usuario (foto → el modelo la ve;
  // documento → se anexa el texto extraído).
  async guardarAdjunto(nombreOriginal: string, datos: Buffer, textoExtraido?: string): Promise<{ nombre: string; tipo: 'imagen' | 'documento' }> {
    const dir = dirAdjuntos(this.cfg.vault, this.fecha, this.idiomaVault);
    mkdirSync(dir, { recursive: true });
    let nombre = nombreSeguro(nombreOriginal);
    const ext = extname(nombre);
    const base = nombre.slice(0, nombre.length - ext.length);
    for (let i = 2; existsSync(join(dir, nombre)); i++) nombre = `${base} (${i})${ext}`;
    writeFileSync(join(dir, nombre), datos);

    const tipo = EXTENSIONES_IMAGEN.has(ext.toLowerCase()) ? 'imagen' : 'documento';
    const b64 = tipo === 'imagen' ? datos.toString('base64') : undefined;
    // El texto extraído de un PDF se persiste como nota compañera junto al
    // archivo: así entra a la memoria RAG y a la búsqueda de Obsidian (el
    // binario no es indexable; un .txt/.md ya es texto por sí mismo).
    if (textoExtraido && tipo === 'documento' && !/\.(md|txt)$/i.test(nombre)) {
      const encabezado = this.idiomaVault === 'en' ? 'Text extracted from' : 'Texto extraído de';
      this.escribirCompanera(dir, nombre, encabezado, textoExtraido.slice(0, 100000));
    }
    this.adjuntosPendientes.push({ nombre, tipo, b64, extracto: textoExtraido?.slice(0, 3000) });
    this.adjuntosSesion.push({ nombre, tipo });

    // Una imagen no tiene texto: se persiste una DESCRIPCIÓN del modelo
    // multimodal como compañera, para que entre a la memoria RAG. Si Ollama
    // falla, el adjunto queda igual — la memoria nunca rompe el flujo.
    if (b64) {
      try {
        const descripcion = await conversar(
          this.cfg,
          [{ role: 'user', content: PROMPT_IMAGEN[this.idiomaVault], images: [b64] }],
          { temperature: 0.2 }
        );
        const limpia = sinPreambulo(descripcion);
        if (limpia) {
          const encabezado = this.idiomaVault === 'en' ? 'Description of' : 'Descripción de';
          this.escribirCompanera(dir, nombre, encabezado, limpia);
        }
      } catch {
        // sin descripción: la imagen igual queda guardada y enlazada
      }
    }
    return { nombre, tipo };
  }

  private escribirCompanera(dir: string, nombre: string, encabezado: string, cuerpo: string): void {
    const rutaRel = `${relative(this.cfg.vault, dir).replace(/\\/g, '/')}/${nombre}`;
    writeFileSync(join(dir, `${nombre}.md`), `${encabezado} [[${rutaRel}]]\n\n${cuerpo}\n`, 'utf8');
  }

  // Devuelve la siguiente pregunta, o null si ya toca finalizar.
  async responder(texto: string): Promise<string | null> {
    let contenido = texto;
    const imagenes: string[] = [];
    if (this.adjuntosPendientes.length) {
      const nombres = this.adjuntosPendientes.map(a => a.nombre).join(', ');
      contenido += this.idiomaUi === 'en' ? `\n[I attached: ${nombres}]` : `\n[Adjunté: ${nombres}]`;
      for (const adjunto of this.adjuntosPendientes) {
        if (adjunto.b64) imagenes.push(adjunto.b64);
        if (adjunto.extracto) {
          contenido += `\n\n--- ${adjunto.nombre} ---\n${adjunto.extracto}\n--- fin ---`;
        }
      }
      this.adjuntosPendientes = [];
    }
    this.mensajes.push({ role: 'user', content: contenido, images: imagenes.length ? imagenes : undefined });
    this.respuestas++;

    // Tras las preguntas guiadas la charla no se corta: entra en cierre
    // abierto ("¿algo más?") hasta que la persona diga que no hay más,
    // con un tope duro de seguridad para no alargar la noche infinito.
    if (this.enCierre && esNegativa(texto)) return null;
    if (this.respuestas >= this.cfg.preguntasMax * 2 + 2) return null;

    if (!this.enCierre && this.respuestas >= this.cfg.preguntasMax) {
      this.enCierre = true;
      const pregunta = PREGUNTAS_CIERRE[this.idiomaUi];
      this.mensajes.push({ role: 'assistant', content: pregunta });
      return pregunta;
    }

    const extra: Mensaje[] = this.enCierre
      ? [{ role: 'system', content: NUDGE_CIERRE[this.idiomaUi] }]
      : [];
    let temperatura = 0.7;

    // memoria de largo plazo: notas viejas relacionadas con lo que acaba de
    // decir, para preguntas tipo "¿cómo siguió X?" — si falla, la
    // entrevista continúa igual
    if (this.rag) {
      // 0.27: calibrado para que frases cortas ("me duele la boca" → 0.289
      // contra la nota del dentista) sí disparen; el ruido medido queda <0.23
      const opciones = { k: 3, min: 0.27, excluir: new RegExp(this.fecha) };
      let recuerdos = await this.rag.buscar(texto, opciones);
      if (texto.trim().length < 60) {
        // respuesta corta ("sí", "¿cuándo me la sacan?"): el tema vive en la
        // pregunta anterior — busca también con ese contexto y fusiona
        // conservando el MEJOR score por chunk (el mismo chunk vuelve con
        // score distinto según la consulta; quedarse con el bajo rompía la
        // puerta de confianza)
        const preguntaPrevia = [...this.mensajes].reverse().find(m => m.role === 'assistant')?.content;
        if (preguntaPrevia) {
          const extras = await this.rag.buscar(`${preguntaPrevia}\n${texto}`, opciones);
          const porClave = new Map(recuerdos.map(r => [`${r.ruta}#${r.seccion}#${r.texto}`, r]));
          for (const r of extras) {
            const clave = `${r.ruta}#${r.seccion}#${r.texto}`;
            const previo = porClave.get(clave);
            if (!previo || r.score > previo.score) porClave.set(clave, r);
          }
          recuerdos = [...porClave.values()].sort((a, b) => b.score - a.score).slice(0, 3);
        }
      }
      // dos niveles: 0.27 basta para ENRIQUECER una pregunta del entrevistador,
      // pero para RESPONDER lo que la persona preguntó se exige 0.32 — un
      // recuerdo débil + la orden de responder = conexión forzada (medido:
      // "¿qué comí el martes?" tope 0.292; pregunta válida fusionada ≥0.349)
      const pregunto = esPregunta(texto);
      const confianzaAlta = recuerdos.length > 0 && recuerdos[0].score >= 0.32;
      if (recuerdos.length && (!pregunto || confianzaAlta)) {
        const contexto = contextoRecuerdos(recuerdos, this.idiomaUi);
        if (contexto) {
          extra.push({ role: 'system', content: contexto });
          if (pregunto) {
            extra.push({ role: 'system', content: NUDGE_RESPONDER[this.idiomaUi] });
            // turno factual: nada de creatividad, hay que citar el recuerdo
            temperatura = 0.2;
          }
        }
      } else if (pregunto) {
        extra.push({ role: 'system', content: NUDGE_SIN_REGISTRO[this.idiomaUi] });
      }
    }

    const bruta = await conversar(this.cfg, [...this.mensajes, ...extra], { temperature: temperatura });
    const respuesta = sinFugaDeContexto(
      bruta,
      extra.map(m => m.content),
      this.idiomaUi
    );
    this.mensajes.push({ role: 'assistant', content: respuesta });
    return respuesta;
  }

  transcripcion(): string {
    const rol = this.idiomaUi === 'en' ? { asistente: 'Interviewer', yo: 'Me' } : { asistente: 'Entrevistador', yo: 'Yo' };
    return this.mensajes
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'assistant' ? rol.asistente : rol.yo}: ${m.content}`)
      .join('\n');
  }

  // La transcripción cruda se guarda SIEMPRE antes de extraer.
  private guardarTranscripcion(): void {
    const marca = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(this.cfg.vault, '.indice', 'sesiones');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${marca}.txt`), `${this.transcripcion()}\n`, 'utf8');
  }

  async finalizar(): Promise<{ plan: ItemPlan[]; extraccion: Extraccion }> {
    this.fase = 'analizando';
    this.guardarTranscripcion();

    const mensajesExtractor: Mensaje[] = [
      { role: 'system', content: sistemaExtractor(this.ctx, this.idiomaUi) },
      { role: 'user', content: `${this.idiomaUi === 'en' ? 'Transcript' : 'Transcripción'}:\n\n${this.transcripcion()}` },
    ];
    let ex: Extraccion;
    try {
      ex = await extraerEstructurado<Extraccion>(this.cfg, mensajesExtractor, ESQUEMA_EXTRACCION);
    } catch {
      ex = await extraerEstructurado<Extraccion>(this.cfg, mensajesExtractor, ESQUEMA_EXTRACCION);
    }

    ex.animo ??= '';
    ex.energia ??= 'desconocida';
    ex.resumen_dia ??= '';
    ex.etiquetas ??= [];
    ex.logros ??= [];
    ex.pendientes ??= [];
    ex.personas ??= [];
    ex.ideas ??= [];

    const conocidos = [...new Set([...Object.keys(cargarIndice(this.cfg.vault).proyectos), ...this.ctx.proyectos])];
    normalizarExtraccion(ex, conocidos);

    this.extraccion = ex;
    this.plan = describirPlan(this.cfg.vault, this.fecha, ex, this.idiomaVault, this.idiomaUi);
    const notaDiaria = `${this.idiomaVault === 'en' ? 'Journal' : 'Diario'}/${this.fecha}.md`;
    for (const adjunto of this.adjuntosSesion) {
      this.plan.push({
        id: `adjunto:${adjunto.nombre}`,
        texto: `${TEXTOS_PLAN[this.idiomaUi].adjunto} "${adjunto.nombre}" → ${notaDiaria}`,
      });
    }
    this.fase = 'plan';
    return { plan: this.plan, extraccion: ex };
  }

  aplicar(excluir: string[] = []): { resultado: ResultadoAplicacion; hash: string | null; totales: string } {
    if (!this.extraccion) throw new Error('No hay extracción que aplicar');
    const ex = filtrarExtraccion(this.extraccion, excluir);
    const fuera = new Set(excluir);
    const adjuntos = this.adjuntosSesion.filter(a => !fuera.has(`adjunto:${a.nombre}`));

    const resultado = aplicarExtraccion(this.cfg.vault, this.fecha, ex, this.idiomaVault);
    const deAdjuntos = aplicarAdjuntos(this.cfg.vault, this.fecha, adjuntos, this.idiomaVault);

    // fusiona ambos resultados por archivo
    const porRuta = new Map(resultado.archivos.map(a => [a.ruta, a]));
    for (const archivo of deAdjuntos.archivos) {
      const previo = porRuta.get(archivo.ruta);
      if (previo) previo.detalles.push(...archivo.detalles.filter(d => !previo.detalles.includes(d)));
      else resultado.archivos.push(archivo);
    }
    resultado.omitidos.push(...deAdjuntos.omitidos);

    const hash =
      (this.cfg.git ?? true)
        ? commitVault(this.cfg.vault, `diario: ${this.idiomaUi === 'en' ? 'session' : 'sesión'} ${this.fecha}`)
        : null;
    this.hashAplicado = hash;
    this.fase = 'aplicada';
    const t = TEXTOS_PLAN[this.idiomaUi];
    let totales = t.totales(ex.logros.length, ex.pendientes.length, ex.personas.length, ex.ideas.length);
    if (adjuntos.length) totales += ` · ${adjuntos.length} ${t.adjunto}(s)`;
    return { resultado, hash, totales };
  }

  // Revierte el commit de esta sesión (git revert en el vault): el diario
  // vuelve a como estaba, pero el historial conserva todo.
  deshacer(): { ok: boolean; detalle: string } {
    if (this.fase !== 'aplicada') return { ok: false, detalle: 'no hay nada aplicado que deshacer' };
    if (!this.hashAplicado) return { ok: false, detalle: 'la sesión no produjo ningún commit' };
    const r = revertirCommit(this.cfg.vault, this.hashAplicado);
    if (r.ok) {
      this.hashAplicado = null;
      // si el commit revertido incluía el marcador de idioma del vault
      // (primera sesión), reponlo: fija el esquema para siempre
      idiomaDelVault(this.cfg.vault, this.idiomaVault);
    }
    return r;
  }
}
