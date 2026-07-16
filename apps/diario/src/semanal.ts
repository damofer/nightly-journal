// Resumen semanal: lee las notas diarias de la semana (lunes a domingo),
// pide al modelo una síntesis y escribe Semanal/<año>-W<semana>.md.
// Pensado para correrse el domingo en la noche: `npm run semana`.
//
// Como siempre: el LLM propone el texto, pero la lista de pendientes que
// siguen abiertos se calcula con código, no con el modelo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { cargarConfig } from './config.js';
import { extraerEstructurado, type Mensaje } from './ollama.js';
import { esIdioma, esquemaVault, type Idioma } from './idioma.js';
import { commitVault, hoyISO, idiomaDelVault } from './vault.js';

const args = process.argv.slice(2);
const valorDe = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};

const gris = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cian = (s: string) => `\x1b[36m${s}\x1b[0m`;
const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;

// ── Semana ISO (lunes a domingo) ────────────────────────────────

function aFecha(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

function aISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function semanaDe(fechaISO: string): { anio: number; semana: number; desde: string; hasta: string } {
  const d = aFecha(fechaISO);
  const lunes = new Date(d);
  lunes.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const domingo = new Date(lunes);
  domingo.setDate(lunes.getDate() + 6);
  // número de semana ISO 8601: la semana del jueves
  const jueves = new Date(lunes);
  jueves.setDate(lunes.getDate() + 3);
  const inicioAnio = new Date(`${jueves.getFullYear()}-01-01T12:00:00`);
  const semana = Math.ceil(((jueves.getTime() - inicioAnio.getTime()) / 86400000 + 1) / 7);
  return { anio: jueves.getFullYear(), semana, desde: aISO(lunes), hasta: aISO(domingo) };
}

// ── Síntesis ────────────────────────────────────────────────────

interface SintesisSemanal {
  resumen_semana: string;
  tendencia_animo: string;
  destacados: string[];
}

const ESQUEMA_SEMANAL = {
  type: 'object',
  required: ['resumen_semana', 'tendencia_animo', 'destacados'],
  properties: {
    resumen_semana: { type: 'string', description: 'Resumen narrativo de la semana en 3-5 frases, primera persona' },
    tendencia_animo: { type: 'string', description: 'Cómo evolucionó el ánimo/energía a lo largo de la semana, 1-2 frases' },
    destacados: { type: 'array', items: { type: 'string' }, description: 'Los 3-5 momentos o logros más importantes de la semana' },
  },
} as const;

function promptSemanal(idioma: Idioma, desde: string, hasta: string): string {
  if (idioma === 'en') {
    return [
      `You summarize a week of personal-journal entries (${desde} to ${hasta}).`,
      `Rules: use ONLY what the notes say, invent nothing, write in English and in first person.`,
      `"resumen_semana": narrative summary of the week (3-5 sentences). "tendencia_animo": how mood/energy evolved. "destacados": the 3-5 most important moments or wins.`,
    ].join('\n');
  }
  return [
    `Resumes una semana de notas de un diario personal (${desde} a ${hasta}).`,
    `Reglas: usa SOLO lo que dicen las notas, no inventes nada, escribe en español y en primera persona.`,
    `"resumen_semana": resumen narrativo de la semana (3-5 frases). "tendencia_animo": cómo evolucionó el ánimo/energía. "destacados": los 3-5 momentos o logros más importantes.`,
  ].join('\n');
}

async function main(): Promise<void> {
  const cfg = cargarConfig();
  if (valorDe('--vault')) cfg.vault = resolve(process.cwd(), valorDe('--vault')!);
  if (valorDe('--modelo')) cfg.modeloExtractor = valorDe('--modelo')!;
  if (esIdioma(valorDe('--idioma'))) cfg.idioma = valorDe('--idioma') as Idioma;
  const idiomaUi: Idioma = cfg.idioma ?? 'es';
  const idiomaVault = idiomaDelVault(cfg.vault, idiomaUi);
  const e = esquemaVault(idiomaVault);

  const fecha = valorDe('--fecha') ?? hoyISO();
  const { anio, semana, desde, hasta } = semanaDe(fecha);
  const etiqueta = `${anio}-W${String(semana).padStart(2, '0')}`;

  console.log(`\n${cian('◆ diario')} — resumen semanal ${etiqueta} (${desde} → ${hasta})`);

  // notas diarias de la semana
  const dirDiario = join(cfg.vault, e.carpetas.diario);
  const notas: { fecha: string; cuerpo: string; animo: string; energia: string }[] = [];
  const pendientesAbiertos: string[] = [];
  for (let d = aFecha(desde); aISO(d) <= hasta; d.setDate(d.getDate() + 1)) {
    const f = aISO(d);
    const ruta = join(dirDiario, `${f}.md`);
    if (!existsSync(ruta)) continue;
    const archivo = matter(readFileSync(ruta, 'utf8'));
    notas.push({
      fecha: f,
      cuerpo: archivo.content.trim(),
      animo: String(archivo.data[e.frontmatter.animo] ?? ''),
      energia: String(archivo.data[e.frontmatter.energia] ?? ''),
    });
    for (const linea of archivo.content.split('\n')) {
      const m = /^\s*-\s*\[ \]\s+(.*)$/.exec(linea);
      if (m) pendientesAbiertos.push(`${m[1]} (${f})`);
    }
  }

  if (!notas.length) {
    console.log(gris('  no hay notas diarias esta semana — nada que resumir\n'));
    return;
  }
  console.log(gris(`  ${notas.length} nota(s) diaria(s) encontradas`));

  const material = notas
    .map(n => `--- ${n.fecha} (${e.frontmatter.animo}: ${n.animo || '-'} · ${e.frontmatter.energia}: ${n.energia || '-'}) ---\n${n.cuerpo}`)
    .join('\n\n')
    .slice(0, 14000);

  console.log(gris(`  sintetizando con ${cfg.modeloExtractor}…`));
  const mensajes: Mensaje[] = [
    { role: 'system', content: promptSemanal(idiomaUi, desde, hasta) },
    { role: 'user', content: material },
  ];
  let s: SintesisSemanal;
  try {
    s = await extraerEstructurado<SintesisSemanal>(cfg, mensajes, ESQUEMA_SEMANAL);
  } catch {
    s = await extraerEstructurado<SintesisSemanal>(cfg, mensajes, ESQUEMA_SEMANAL);
  }
  s.resumen_semana ??= '';
  s.tendencia_animo ??= '';
  s.destacados ??= [];

  // títulos de sección de la nota semanal, por idioma del vault
  const t =
    idiomaVault === 'en'
      ? { resumen: 'Summary', animo: 'Mood trend', destacados: 'Highlights', abiertos: 'Still open' }
      : { resumen: 'Resumen', animo: 'Tendencia de ánimo', destacados: 'Destacados', abiertos: 'Siguen abiertos' };

  const lineas = [
    '---',
    `${e.frontmatter.semana}: "${etiqueta}"`,
    `${e.frontmatter.desde}: "${desde}"`,
    `${e.frontmatter.hasta}: "${hasta}"`,
    '---',
    '',
    `# ${e.tituloSemanal(anio, semana)}`,
    '',
    `## ${t.resumen}`,
    '',
    s.resumen_semana.trim(),
    '',
    `## ${t.animo}`,
    '',
    s.tendencia_animo.trim(),
    '',
    `## ${t.destacados}`,
    '',
    ...s.destacados.filter(d => d.trim()).map(d => `- ${d.trim()}`),
    '',
  ];
  const enlaces = notas.map(n => `[[${n.fecha}]]`).join(' · ');
  if (pendientesAbiertos.length) {
    lineas.push(`## ${t.abiertos}`, '', ...pendientesAbiertos.slice(0, 12).map(p => `- [ ] ${p}`), '');
  }
  lineas.push('---', '', enlaces, '');

  const dirSemanal = join(cfg.vault, e.carpetas.semanal);
  mkdirSync(dirSemanal, { recursive: true });
  const rutaNota = join(dirSemanal, `${etiqueta}.md`);
  writeFileSync(rutaNota, lineas.join('\n'), 'utf8');

  const hash = commitVault(cfg.vault, `diario: resumen semanal ${etiqueta}`);
  console.log(`\n  ${verde('✓')} ${e.carpetas.semanal}/${etiqueta}.md${hash ? gris(` · commit ${hash}`) : ''}\n`);
}

// Solo corre como CLI (el import de pruebas usa semanaDe sin efectos)
if (process.argv[1] && /semanal\.(ts|js|cjs)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`\n\x1b[31m✗ ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    process.exit(1);
  });
}
