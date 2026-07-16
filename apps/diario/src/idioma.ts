// Módulo de idioma: textos de UI, etiquetas del plan y el "esquema" del
// vault (nombres de carpetas, secciones y claves de frontmatter) en español
// e inglés. El idioma del VAULT se fija la primera vez que se escribe en él
// (.indice/idioma) para que cambiar el idioma de la app no fragmente las
// notas existentes en dos esquemas.

export type Idioma = 'es' | 'en';

export function esIdioma(v: unknown): v is Idioma {
  return v === 'es' || v === 'en';
}

export interface EsquemaVault {
  carpetas: {
    diario: string;
    personas: string;
    proyectos: string;
    adjuntos: string;
    semanal: string;
  };
  secciones: {
    resumen: string;
    logros: string;
    pendientes: string;
    relacionado: string;
    interacciones: string;
    ideas: string;
    backlog: string;
    avances: string;
    adjuntos: string;
  };
  frontmatter: {
    fecha: string;
    animo: string;
    energia: string;
    tipo: string;
    semana: string;
    desde: string;
    hasta: string;
  };
  tipos: { persona: string; proyecto: string };
  energias: Record<'baja' | 'media' | 'alta' | 'desconocida', string>;
  tituloDiario(fecha: string): string;
  tituloSemanal(anio: number, semana: number): string;
}

const ESQUEMAS: Record<Idioma, EsquemaVault> = {
  es: {
    carpetas: { diario: 'Diario', personas: 'Personas', proyectos: 'Proyectos', adjuntos: 'Adjuntos', semanal: 'Semanal' },
    secciones: {
      resumen: 'Resumen',
      logros: 'Logros',
      pendientes: 'Pendientes',
      relacionado: 'Relacionado',
      interacciones: 'Interacciones',
      ideas: 'Ideas',
      backlog: 'Backlog',
      avances: 'Avances',
      adjuntos: 'Adjuntos',
    },
    frontmatter: { fecha: 'fecha', animo: 'animo', energia: 'energia', tipo: 'tipo', semana: 'semana', desde: 'desde', hasta: 'hasta' },
    tipos: { persona: 'persona', proyecto: 'proyecto' },
    energias: { baja: 'baja', media: 'media', alta: 'alta', desconocida: 'desconocida' },
    tituloDiario: fecha => `Bitácora ${fecha}`,
    tituloSemanal: (anio, semana) => `Semana ${anio}-W${String(semana).padStart(2, '0')}`,
  },
  en: {
    carpetas: { diario: 'Journal', personas: 'People', proyectos: 'Projects', adjuntos: 'Attachments', semanal: 'Weekly' },
    secciones: {
      resumen: 'Summary',
      logros: 'Wins',
      pendientes: 'To-do',
      relacionado: 'Related',
      interacciones: 'Interactions',
      ideas: 'Ideas',
      backlog: 'Backlog',
      avances: 'Progress',
      adjuntos: 'Attachments',
    },
    frontmatter: { fecha: 'date', animo: 'mood', energia: 'energy', tipo: 'type', semana: 'week', desde: 'from', hasta: 'to' },
    tipos: { persona: 'person', proyecto: 'project' },
    energias: { baja: 'low', media: 'medium', alta: 'high', desconocida: 'unknown' },
    tituloDiario: fecha => `Journal ${fecha}`,
    tituloSemanal: (anio, semana) => `Week ${anio}-W${String(semana).padStart(2, '0')}`,
  },
};

export function esquemaVault(idioma: Idioma): EsquemaVault {
  return ESQUEMAS[idioma];
}

// Nivel numérico de energía para la mini-gráfica, tolerante a vaults en
// cualquiera de los dos idiomas.
export const NIVEL_ENERGIA: Record<string, number> = {
  baja: 1, low: 1,
  media: 2, medium: 2,
  alta: 3, high: 3,
};

// ── Etiquetas del plan de escritura ─────────────────────────────

export interface TextosPlan {
  animo: string;
  energia: string;
  resumen: string;
  logro: string;
  pendiente: string;
  interaccion: string;
  idea: string;
  adjunto: string;
  nueva: string;
  creada: string;
  yaEstaba: string;
  totales(l: number, p: number, i: number, d: number): string;
}

export const TEXTOS_PLAN: Record<Idioma, TextosPlan> = {
  es: {
    animo: 'ánimo',
    energia: 'energía',
    resumen: 'resumen',
    logro: 'logro',
    pendiente: 'pendiente',
    interaccion: 'interacción con',
    idea: 'idea',
    adjunto: 'adjunto',
    nueva: ' (nueva)',
    creada: 'creada',
    yaEstaba: 'ya estaba',
    totales: (l, p, i, d) => `${l} logro(s) · ${p} pendiente(s) · ${i} interacción(es) · ${d} idea(s)`,
  },
  en: {
    animo: 'mood',
    energia: 'energy',
    resumen: 'summary',
    logro: 'win',
    pendiente: 'to-do',
    interaccion: 'interaction with',
    idea: 'idea',
    adjunto: 'attachment',
    nueva: ' (new)',
    creada: 'created',
    yaEstaba: 'already there',
    totales: (l, p, i, d) => `${l} win(s) · ${p} to-do(s) · ${i} interaction(s) · ${d} idea(s)`,
  },
};

// ── Textos de la interfaz web ───────────────────────────────────
// Se inyectan en el HTML al servirlo; la UI no tiene strings propios.

export interface TextosUi {
  titulo: string;
  marca: string;
  placeholder: string;
  adjuntar: string;
  hablar: string;
  enviar: string;
  cerrarDia: string;
  manosLibresNo: string;
  manosLibresSi: string;
  vozCargando: string;
  vozLista: string;
  soloTexto: string;
  motorKokoro: string;
  motorOff: string;
  generos: { f: string; m: string };
  avisoAudio: string;
  rachaTitulo: string; // plantilla con {n}
  preparando: string;
  pensando: string;
  transcribiendo: string;
  analizando: string;
  escribiendo: string;
  noEntendi: string;
  errorMic: string;
  errorTranscribir: string;
  errorIniciar: string;
  sugerenciaOllama: string;
  planTitulo: string;
  planAplicar: string;
  planDescartar: string;
  planVozIntro: string;
  guardadoTitulo: string;
  guardadoDespedida: string;
  guardadoDespedidaVoz: string;
  deshacer: string;
  deshecho: string;
  descartado: string;
  sesionVacia: string;
  nuevaSesion: string;
  adjuntoSoloEnlace: string;
  adjuntoError: string; // plantilla con {nombre}
  teComparto: string;
  manosLibresAviso: string;
  manosLibresEscuchando: string;
  idiomaBoton: string;
  estadoTitulo: string;
  estadoSinOllama: string;
  estadoDescargarOllama: string;
  estadoSinModelo: string; // plantilla con {modelo}
  estadoBotonModelo: string;
  estadoDescargando: string;
  estadoReintentar: string;
  pestanaRegistrar: string;
  pestanaConsultar: string;
  consultaPlaceholder: string;
  consultaIntro: string;
  consultaSinMemoria: string;
  consultaFuentes: string;
}

export const TEXTOS_UI: Record<Idioma, TextosUi> = {
  es: {
    titulo: 'diario — cierre del día',
    marca: '◆ diario',
    placeholder: 'cuéntame de tu día…',
    adjuntar: 'adjuntar foto o documento',
    hablar: 'hablar',
    enviar: 'enviar',
    cerrarDia: '☾ cerrar el día y registrar',
    manosLibresNo: '🎤 manos libres: no',
    manosLibresSi: '🎤 manos libres: sí',
    vozCargando: 'cargando voz…',
    vozLista: 'voz lista',
    soloTexto: 'solo texto',
    motorKokoro: '⚡ voz: sí',
    motorOff: '🔇 voz: no',
    generos: { f: 'mujer', m: 'hombre' },
    avisoAudio: '🔊 toca para activar la voz',
    rachaTitulo: 'llevas {n} noche(s) seguida(s) escribiendo — las barras son tu energía de la semana',
    preparando: 'preparando la entrevista…',
    pensando: 'pensando…',
    transcribiendo: 'transcribiendo…',
    analizando: 'analizando la charla…',
    escribiendo: 'escribiendo tus notas…',
    noEntendi: 'no te entendí, intenta de nuevo',
    errorMic: 'no pude acceder al micrófono',
    errorTranscribir: 'error transcribiendo',
    errorIniciar: 'no pude iniciar',
    sugerenciaOllama: '¿está corriendo Ollama? recarga la página para reintentar',
    planTitulo: 'plan de escritura — desmarca lo que no quieras guardar',
    planAplicar: '✓ escribir en mis notas',
    planDescartar: 'no escribir',
    planVozIntro: 'Listo, este es el plan. Desmarca lo que no quieras y confirma.',
    guardadoTitulo: 'guardado',
    guardadoDespedida: 'Listo, quedó todo guardado. Descansa. ✦',
    guardadoDespedidaVoz: 'Listo, quedó todo guardado. Que descanses.',
    deshacer: '↶ deshacer',
    deshecho: 'deshecho — el vault volvió a como estaba antes de la sesión',
    descartado: 'no escribí nada — la transcripción quedó guardada por si cambias de idea',
    sesionVacia: 'no contaste nada hoy — no hay nada que registrar',
    nuevaSesion: '↺ nueva sesión',
    adjuntoSoloEnlace: ' (solo enlace)',
    adjuntoError: 'no pude adjuntar {nombre}',
    teComparto: '(te comparto esto)',
    manosLibresAviso: 'manos libres activado — habla cuando quieras, envío solo cuando hagas una pausa',
    manosLibresEscuchando: 'escuchando…',
    idiomaBoton: '🌐 español',
    estadoTitulo: 'primer arranque',
    estadoSinOllama: 'El diario piensa con Ollama y no lo encuentro corriendo. Instálalo (gratis, local) y vuelve a intentar.',
    estadoDescargarOllama: '⬇ descargar Ollama',
    estadoSinModelo: 'Ollama está corriendo pero falta el modelo {modelo} (unos GB, se descarga una sola vez).',
    estadoBotonModelo: '⬇ descargar el modelo',
    estadoDescargando: 'descargando el modelo… esto tarda varios minutos, no cierres esta ventana',
    estadoReintentar: '↻ reintentar',
    pestanaRegistrar: '✎ registrar',
    pestanaConsultar: '🔍 consultar',
    consultaPlaceholder: 'pregúntale a tu memoria…',
    consultaIntro: 'Pregúntame por lo que has escrito: personas, proyectos, lo que contaste hace semanas… Respondo solo con tus notas, citando la fecha.',
    consultaSinMemoria: 'La memoria de largo plazo está desactivada. Configura el modelo de embeddings en los ajustes (una vez: ollama pull embeddinggemma).',
    consultaFuentes: 'fuentes:',
  },
  en: {
    titulo: 'diario — daily check-in',
    marca: '◆ diario',
    placeholder: 'tell me about your day…',
    adjuntar: 'attach a photo or document',
    hablar: 'speak',
    enviar: 'send',
    cerrarDia: '☾ close the day and save',
    manosLibresNo: '🎤 hands-free: off',
    manosLibresSi: '🎤 hands-free: on',
    vozCargando: 'loading voice…',
    vozLista: 'voice ready',
    soloTexto: 'text only',
    motorKokoro: '⚡ voice: on',
    motorOff: '🔇 voice: off',
    generos: { f: 'woman', m: 'man' },
    avisoAudio: '🔊 tap to enable audio',
    rachaTitulo: '{n} night(s) in a row — the bars show your energy this week',
    preparando: 'getting the interview ready…',
    pensando: 'thinking…',
    transcribiendo: 'transcribing…',
    analizando: 'reviewing the conversation…',
    escribiendo: 'writing your notes…',
    noEntendi: "I didn't catch that, try again",
    errorMic: "couldn't access the microphone",
    errorTranscribir: 'transcription error',
    errorIniciar: "couldn't start",
    sugerenciaOllama: 'is Ollama running? reload the page to retry',
    planTitulo: "writing plan — untick anything you don't want saved",
    planAplicar: '✓ write to my notes',
    planDescartar: "don't write",
    planVozIntro: "Here's the plan. Untick anything you don't want and confirm.",
    guardadoTitulo: 'saved',
    guardadoDespedida: 'Done, everything is saved. Rest well. ✦',
    guardadoDespedidaVoz: 'Done, everything is saved. Rest well.',
    deshacer: '↶ undo',
    deshecho: 'undone — the vault is back to how it was before this session',
    descartado: "nothing was written — the transcript is saved in case you change your mind",
    sesionVacia: "you didn't share anything today — nothing to save",
    nuevaSesion: '↺ new session',
    adjuntoSoloEnlace: ' (link only)',
    adjuntoError: "couldn't attach {nombre}",
    teComparto: "(sharing this with you)",
    manosLibresAviso: 'hands-free on — just talk, I send when you pause',
    manosLibresEscuchando: 'listening…',
    idiomaBoton: '🌐 english',
    estadoTitulo: 'first run',
    estadoSinOllama: "The journal thinks with Ollama and I can't find it running. Install it (free, local) and try again.",
    estadoDescargarOllama: '⬇ download Ollama',
    estadoSinModelo: 'Ollama is running but the model {modelo} is missing (a few GB, downloaded once).',
    estadoBotonModelo: '⬇ download the model',
    estadoDescargando: "downloading the model… this takes several minutes, don't close this window",
    estadoReintentar: '↻ retry',
    pestanaRegistrar: '✎ journal',
    pestanaConsultar: '🔍 ask',
    consultaPlaceholder: 'ask your memory…',
    consultaIntro: "Ask me about what you've written: people, projects, things you told me weeks ago… I answer only from your notes, citing the date.",
    consultaSinMemoria: 'Long-term memory is off. Set the embeddings model in settings (once: ollama pull embeddinggemma).',
    consultaFuentes: 'sources:',
  },
};
