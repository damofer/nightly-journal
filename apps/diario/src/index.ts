import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crearConsola } from './consola.js';
import { cargarConfig } from './config.js';
import { conversar, extraerEstructurado, type Mensaje } from './ollama.js';
import { ESQUEMA_EXTRACCION, type Extraccion } from './esquema.js';
import { construirContexto, sistemaEntrevista, sistemaExtractor } from './entrevistador.js';
import { aplicarExtraccion, describirPlan } from './aplicador.js';
import { normalizarExtraccion } from './normalizador.js';
import { cargarIndice } from './entidades.js';
import { esIdioma, TEXTOS_PLAN, type Idioma } from './idioma.js';
import { asegurarVault, commitVault, hoyISO, idiomaDelVault } from './vault.js';

const args = process.argv.slice(2);
const tiene = (f: string) => args.includes(f);
const valorDe = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};

const gris = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cian = (s: string) => `\x1b[36m${s}\x1b[0m`;
const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amarillo = (s: string) => `\x1b[33m${s}\x1b[0m`;

const DEMO_TRANSCRIPCION = [
  'Entrevistador: ¡Hola! ¿Cómo estuvo tu día hoy?',
  'Yo: Pesado pero bien. Estuve toda la mañana peleando con un bug de React del trabajo y al final lo resolví.',
  'Entrevistador: Qué bien que saliera. ¿Y avanzaste en algo tuyo?',
  'Yo: Del auto-battler no toqué código, pero Mary me ayudó a aterrizar ideas del sistema de combate mientras cenábamos. Me queda pendiente retomar el script de combate.',
].join('\n');

const DEMO_EXTRACCION: Extraccion = {
  animo: 'cansado pero satisfecho',
  energia: 'media',
  resumen_dia:
    'Día enfocado en destrabar el trabajo: resolví un bug de React que me tenía frenado toda la mañana. En la noche, lluvia de ideas del auto-battler con Mary.',
  etiquetas: ['trabajo', 'gamedev'],
  logros: [{ descripcion: 'Resolver el bug de React del trabajo' }],
  pendientes: [{ descripcion: 'Retomar el script de combate', proyecto: 'Auto-battler' }],
  personas: [{ nombre: 'Mary', detalle: 'Me ayudó a diseñar ideas del sistema de combate durante la cena' }],
  ideas: [{ proyecto: 'Auto-battler', idea: 'Sistema de combate por turnos con sinergias entre unidades' }],
};

async function main(): Promise<void> {
  const cfg = cargarConfig();
  const modelo = valorDe('--modelo');
  if (modelo) {
    cfg.modelo = modelo;
    cfg.modeloExtractor = modelo;
  }
  if (valorDe('--vault')) cfg.vault = resolve(process.cwd(), valorDe('--vault')!);
  if (esIdioma(valorDe('--idioma'))) cfg.idioma = valorDe('--idioma') as Idioma;
  const demo = tiene('--demo');
  const autoSi = tiene('--si');
  if (demo && !valorDe('--vault')) cfg.vault = `${cfg.vault}-demo`;
  if (tiene('--rapido')) cfg.preguntasMax = 1;

  const idiomaUi: Idioma = cfg.idioma ?? 'es';
  const idiomaVault = idiomaDelVault(cfg.vault, idiomaUi);
  const rol = idiomaUi === 'en' ? { asistente: 'Interviewer', yo: 'Me' } : { asistente: 'Entrevistador', yo: 'Yo' };

  const fecha = hoyISO();
  console.log(`\n${cian('◆ diario')} — cierre del día · ${fecha}`);
  console.log(gris(`  modelo ${cfg.modelo} · vault ${cfg.vault} · idioma ${idiomaUi}`));
  console.log(gris(`  escribe /fin para cerrar antes, /salir para descartar\n`));

  asegurarVault(cfg.vault, idiomaVault);
  const ctx = construirContexto(cfg.vault, fecha, idiomaVault);

  const consola = crearConsola();

  let transcripcion: string;

  if (demo) {
    console.log(gris('modo demo: sesión de ejemplo enlatada, sin modelo\n'));
    transcripcion = DEMO_TRANSCRIPCION;
  } else {
    const mensajes: Mensaje[] = [{ role: 'system', content: sistemaEntrevista(ctx, cfg.preguntasMax, idiomaUi) }];
    const saludo = await conversar(cfg, mensajes);
    mensajes.push({ role: 'assistant', content: saludo });
    console.log(`${cian('◆')} ${saludo}\n`);

    let respuestas = 0;
    while (respuestas < cfg.preguntasMax) {
      const linea = (await consola.preguntar('tú › ')).trim();
      if (!linea) continue;
      if (linea === '/salir') {
        consola.cerrar();
        console.log(gris('\nSesión descartada, no escribí nada.'));
        return;
      }
      if (linea === '/fin') break;
      mensajes.push({ role: 'user', content: linea });
      respuestas++;
      if (respuestas >= cfg.preguntasMax) break;
      const respuesta = await conversar(cfg, mensajes);
      mensajes.push({ role: 'assistant', content: respuesta });
      console.log(`\n${cian('◆')} ${respuesta}\n`);
    }

    if (!mensajes.some(m => m.role === 'user')) {
      consola.cerrar();
      console.log(gris('\nNo contaste nada hoy — no registro nada.'));
      return;
    }
    transcripcion = mensajes
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'assistant' ? rol.asistente : rol.yo}: ${m.content}`)
      .join('\n');
  }

  // La transcripción cruda se guarda SIEMPRE antes de extraer: aunque la
  // extracción falle, lo que contaste nunca se pierde.
  const marcaTiempo = new Date().toISOString().replace(/[:.]/g, '-');
  const dirSesiones = join(cfg.vault, '.indice', 'sesiones');
  mkdirSync(dirSesiones, { recursive: true });
  writeFileSync(join(dirSesiones, `${marcaTiempo}.txt`), `${transcripcion}\n`, 'utf8');

  let ex: Extraccion;
  if (demo) {
    ex = DEMO_EXTRACCION;
  } else {
    console.log(gris('\nanalizando la charla…'));
    const mensajesExtractor: Mensaje[] = [
      { role: 'system', content: sistemaExtractor(ctx, idiomaUi) },
      { role: 'user', content: `${idiomaUi === 'en' ? 'Transcript' : 'Transcripción'}:\n\n${transcripcion}` },
    ];
    try {
      ex = await extraerEstructurado<Extraccion>(cfg, mensajesExtractor, ESQUEMA_EXTRACCION);
    } catch {
      ex = await extraerEstructurado<Extraccion>(cfg, mensajesExtractor, ESQUEMA_EXTRACCION);
    }
  }

  ex.animo ??= '';
  ex.energia ??= 'desconocida';
  ex.resumen_dia ??= '';
  ex.etiquetas ??= [];
  ex.logros ??= [];
  ex.pendientes ??= [];
  ex.personas ??= [];
  ex.ideas ??= [];

  const proyectosConocidos = [...new Set([...Object.keys(cargarIndice(cfg.vault).proyectos), ...ctx.proyectos])];
  normalizarExtraccion(ex, proyectosConocidos);

  const plan = describirPlan(cfg.vault, fecha, ex, idiomaVault, idiomaUi);
  if (!plan.length) {
    consola.cerrar();
    console.log(amarillo('\nNo encontré nada concreto que registrar. La transcripción quedó guardada.'));
    return;
  }

  console.log(`\n${cian('plan de escritura')}`);
  for (const item of plan) console.log(`  ${gris('→')} ${item.texto}`);

  if (!autoSi) {
    const ok = (await consola.preguntar('\n¿escribo esto en tus notas? (s/n) › ')).trim().toLowerCase();
    if (!['s', 'si', 'sí', 'y', 'yes'].includes(ok)) {
      consola.cerrar();
      console.log(gris('No escribí nada. La transcripción quedó guardada por si cambias de idea.'));
      return;
    }
  }
  consola.cerrar();

  const resultado = aplicarExtraccion(cfg.vault, fecha, ex, idiomaVault);
  console.log('');
  for (const archivo of resultado.archivos) {
    console.log(`  ${verde('✓')} ${archivo.ruta} ${gris(`· ${archivo.detalles.join(' · ')}`)}`);
  }
  for (const omitido of resultado.omitidos) console.log(`  ${gris(`≡ ${omitido}`)}`);

  const hash = commitVault(cfg.vault, `diario: sesión ${fecha}`);
  const totales = TEXTOS_PLAN[idiomaUi].totales(ex.logros.length, ex.pendientes.length, ex.personas.length, ex.ideas.length);
  console.log(`\n${verde('listo.')} ${totales}${hash ? gris(` · commit ${hash}`) : ''}`);
  console.log(gris('descansa.\n'));
}

main().catch((e: unknown) => {
  console.error(`\n\x1b[31m✗ ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
  process.exit(1);
});
