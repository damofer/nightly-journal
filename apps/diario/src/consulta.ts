// Consulta a la memoria del diario: preguntas libres sobre el propio pasado,
// respondidas SOLO con recuerdos recuperados del RAG y citando la nota y su
// fecha. Es el modo "lectura" del diario — nunca escribe en el vault.
//
// Puertas de confianza calibradas con embeddinggemma (mismas de sesion.ts):
// >= 0.27 el recuerdo entra a la búsqueda; >= 0.32 el modelo RESPONDE con él.
// Entre medias no se llama al LLM: se muestran las fuentes con una respuesta
// honesta determinista — un recuerdo flojo + orden de responder inventa
// conexiones (medido).

import type { Config } from './config.js';
import type { Idioma } from './idioma.js';
import { conversar, type Mensaje } from './ollama.js';
import { etiquetaRecuerdo, type Rag, type ResultadoRag } from './rag.js';

export interface RespuestaConsulta {
  respuesta: string;
  fuentes: ResultadoRag[];
}

const UMBRAL_BUSQUEDA = 0.27;
const UMBRAL_RESPUESTA = 0.32;
const K = 4;

const SISTEMA: Record<Idioma, string> = {
  es: `Eres la memoria del diario personal de la persona que te habla. Te paso FRAGMENTOS de notas que ella misma escribió (el [corchete] es la nota; su nombre lleva la fecha, ej. Diario/2026-07-02 = 2 de julio de 2026) y su pregunta.
Reglas:
- Responde SOLO con lo que dicen los fragmentos, citando la fecha real: "En tu nota del 2 de julio escribiste que…".
- Si el corchete dice "documento … adjuntado el …" o "imagen … adjuntada el …", cítalo así: "en el documento que adjuntaste el 15 de julio…" / "en la imagen que adjuntaste el 15 de julio…" — NO digas "escribiste" de un documento o imagen.
- Nunca inventes detalles que no estén en los fragmentos.
- Si los fragmentos no responden la pregunta, dilo honestamente: "No tengo eso registrado en tus notas."
- Sé breve: 1 a 3 frases, cálidas y directas. Sin listas ni encabezados.`,
  en: `You are the memory of this person's personal journal. I give you FRAGMENTS of notes they wrote themselves (the [bracket] is the note; its name carries the date, e.g. Journal/2026-07-02 = July 2, 2026) and their question.
Rules:
- Answer ONLY with what the fragments say, citing the real date: "In your July 2nd note you wrote that…".
- If the bracket says "document … attached on …" or "image … attached on …", cite it as such: "in the document/image you attached on July 15…" — do NOT say "you wrote" about a document or image.
- Never invent details that are not in the fragments.
- If the fragments don't answer the question, say so honestly: "I don't have that in your notes."
- Keep it short: 1 to 3 sentences, warm and direct. No lists or headings.`,
};

const ETIQUETA_RECUERDOS: Record<Idioma, string> = {
  es: 'FRAGMENTOS DE TUS NOTAS:',
  en: 'FRAGMENTS FROM YOUR NOTES:',
};

const ETIQUETA_PREGUNTA: Record<Idioma, string> = {
  es: 'PREGUNTA',
  en: 'QUESTION',
};

const SIN_RESULTADOS: Record<Idioma, string> = {
  es: 'No encontré nada sobre eso en tus notas.',
  en: "I couldn't find anything about that in your notes.",
};

const SOLO_PARECIDO: Record<Idioma, string> = {
  es: 'No tengo eso registrado con claridad, pero esto es lo más parecido que encontré:',
  en: "I don't have that clearly on record, but this is the closest I found:",
};

export class ConsultaDiario {
  private historial: Mensaje[] = [];
  private preguntaPrevia = '';
  readonly idioma: Idioma;

  constructor(
    private cfg: Config,
    private rag: Rag
  ) {
    this.idioma = cfg.idioma === 'en' ? 'en' : 'es';
  }

  async preguntar(texto: string): Promise<RespuestaConsulta> {
    const opciones = { k: K, min: UMBRAL_BUSQUEDA };
    let recuerdos = await this.rag.buscar(texto, opciones);

    // seguimiento corto ("¿y cuándo?"): fusionar con la pregunta previa
    // CONSERVANDO el mejor score por chunk (receta probada en sesion.ts —
    // quedarse con el score bajo cerraba la puerta de respuesta)
    if (texto.length < 60 && this.preguntaPrevia) {
      const extra = await this.rag.buscar(`${this.preguntaPrevia}\n${texto}`, opciones);
      const porClave = new Map<string, ResultadoRag>();
      for (const r of [...recuerdos, ...extra]) {
        const clave = `${r.ruta}#${r.seccion}#${r.texto}`;
        const previo = porClave.get(clave);
        if (!previo || r.score > previo.score) porClave.set(clave, r);
      }
      recuerdos = [...porClave.values()].sort((a, b) => b.score - a.score).slice(0, K);
    }
    this.preguntaPrevia = texto;

    if (!recuerdos.length) return { respuesta: SIN_RESULTADOS[this.idioma], fuentes: [] };
    if (recuerdos[0].score < UMBRAL_RESPUESTA) {
      return { respuesta: SOLO_PARECIDO[this.idioma], fuentes: recuerdos };
    }

    const bloque = recuerdos
      .map(r => `- [${etiquetaRecuerdo(r.ruta, this.idioma)}] ${r.texto.split('\n').slice(1).join(' ').slice(0, 400)}`)
      .join('\n');
    const mensajes: Mensaje[] = [
      { role: 'system', content: SISTEMA[this.idioma] },
      ...this.historial,
      {
        role: 'user',
        content: `${ETIQUETA_RECUERDOS[this.idioma]}\n${bloque}\n\n${ETIQUETA_PREGUNTA[this.idioma]}: ${texto}`,
      },
    ];
    const respuesta = await conversar(this.cfg, mensajes, { temperature: 0.2 });

    // historial corto para seguimientos; se guarda la pregunta LIMPIA (sin
    // el bloque de fragmentos, que engordaría cada turno siguiente)
    this.historial.push({ role: 'user', content: texto }, { role: 'assistant', content: respuesta });
    if (this.historial.length > 6) this.historial.splice(0, this.historial.length - 6);

    return { respuesta, fuentes: recuerdos };
  }
}
