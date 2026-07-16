import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { esIdioma, esquemaVault, type Idioma } from './idioma.js';

// Fecha local (no UTC) en formato YYYY-MM-DD.
export function hoyISO(): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const sanear = (nombre: string) =>
  nombre
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim();

// El idioma del vault se fija la PRIMERA vez y queda grabado en
// .indice/idioma: cambiar el idioma de la app después no debe partir un
// vault existente en dos esquemas (Diario/ y Journal/ a la vez).
export function idiomaDelVault(vault: string, deseado: Idioma): Idioma {
  const ruta = join(vault, '.indice', 'idioma');
  if (existsSync(ruta)) {
    const guardado = readFileSync(ruta, 'utf8').trim();
    if (esIdioma(guardado)) return guardado;
  }
  mkdirSync(join(vault, '.indice'), { recursive: true });
  writeFileSync(ruta, `${deseado}\n`, 'utf8');
  return deseado;
}

export function rutaDiario(vault: string, fecha: string, idioma: Idioma = 'es'): string {
  return join(vault, esquemaVault(idioma).carpetas.diario, `${fecha}.md`);
}

export function rutaPersona(vault: string, nombre: string, idioma: Idioma = 'es'): string {
  return join(vault, esquemaVault(idioma).carpetas.personas, `${sanear(nombre)}.md`);
}

export function rutaProyecto(vault: string, nombre: string, idioma: Idioma = 'es'): string {
  return join(vault, esquemaVault(idioma).carpetas.proyectos, `${sanear(nombre)}.md`);
}

export function dirAdjuntos(vault: string, fecha: string, idioma: Idioma = 'es'): string {
  return join(vault, esquemaVault(idioma).carpetas.adjuntos, fecha);
}

export function nombreSeguro(nombre: string): string {
  return sanear(nombre) || 'archivo';
}

export function plantillaDiario(fecha: string, idioma: Idioma = 'es'): string {
  const e = esquemaVault(idioma);
  const fm = e.frontmatter;
  return [
    '---',
    `${fm.fecha}: "${fecha}"`,
    `${fm.animo}: ""`,
    `${fm.energia}: ${e.energias.desconocida}`,
    'tags: []',
    '---',
    '',
    `# ${e.tituloDiario(fecha)}`,
    '',
    `## ${e.secciones.resumen}`,
    '',
    `## ${e.secciones.logros}`,
    '',
    `## ${e.secciones.pendientes}`,
    '',
    `## ${e.secciones.relacionado}`,
    '',
  ].join('\n');
}

export function plantillaPersona(nombre: string, idioma: Idioma = 'es'): string {
  const e = esquemaVault(idioma);
  return `---\n${e.frontmatter.tipo}: ${e.tipos.persona}\n---\n\n# ${nombre}\n\n## ${e.secciones.interacciones}\n`;
}

export function plantillaProyecto(nombre: string, idioma: Idioma = 'es'): string {
  const e = esquemaVault(idioma);
  return `---\n${e.frontmatter.tipo}: ${e.tipos.proyecto}\n---\n\n# ${nombre}\n\n## ${e.secciones.ideas}\n\n## ${e.secciones.backlog}\n\n## ${e.secciones.avances}\n`;
}

// Crea las carpetas del vault si no existen. Con `conGit` (default) además
// lo vuelve su propio repo: cada sesión se auto-commitea y se puede
// deshacer. El plugin de Obsidian pasa `false` salvo que el usuario lo
// active: jamás hay que crear un .git (ni un .gitignore) dentro del vault
// de alguien sin permiso.
export function asegurarVault(vault: string, idioma: Idioma = 'es', conGit = true): void {
  const c = esquemaVault(idioma).carpetas;
  for (const carpeta of [c.diario, c.personas, c.proyectos, '.indice']) {
    mkdirSync(join(vault, carpeta), { recursive: true });
  }
  if (!conGit) return;
  // Fuera del historial: el estado de ventanas de Obsidian y el índice de
  // embeddings del RAG (pesado y regenerable).
  const ignorar = join(vault, '.gitignore');
  const lineas = ['.obsidian/', '.indice/rag.json'];
  const previo = existsSync(ignorar) ? readFileSync(ignorar, 'utf8') : '';
  const faltantes = lineas.filter(l => !previo.split('\n').some(p => p.trim() === l));
  if (faltantes.length) {
    const base = previo && !previo.endsWith('\n') ? `${previo}\n` : previo;
    writeFileSync(ignorar, `${base}${faltantes.join('\n')}\n`, 'utf8');
  }
  if (!existsSync(join(vault, '.git'))) {
    const init = git(vault, ['init', '-b', 'main']);
    if (init.ok) git(vault, ['commit', '--allow-empty', '-m', 'vault inicial']);
  }
}

export function git(vault: string, args: string[]): { ok: boolean; salida: string } {
  const r = spawnSync('git', args, { cwd: vault, encoding: 'utf8' });
  return { ok: r.status === 0, salida: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export function commitVault(vault: string, mensaje: string): string | null {
  git(vault, ['add', '-A']);
  const commit = git(vault, ['commit', '-m', mensaje]);
  if (!commit.ok) return null;
  const hash = git(vault, ['rev-parse', '--short', 'HEAD']);
  return hash.ok ? hash.salida : null;
}

// Revierte el commit de una sesión (git revert: queda historial, no se
// pierde nada). Solo si HEAD sigue siendo ese commit.
export function revertirCommit(vault: string, hash: string): { ok: boolean; detalle: string } {
  const head = git(vault, ['rev-parse', '--short', 'HEAD']);
  if (!head.ok || head.salida !== hash) {
    return { ok: false, detalle: `HEAD ya no es ${hash} (hubo cambios después)` };
  }
  const r = git(vault, ['revert', '--no-edit', hash]);
  return { ok: r.ok, detalle: r.salida };
}

export function notaDiariaAnterior(
  vault: string,
  fecha: string,
  idioma: Idioma = 'es'
): { fecha: string; contenido: string } | null {
  const dir = join(vault, esquemaVault(idioma).carpetas.diario);
  if (!existsSync(dir)) return null;
  const previas = readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f < `${fecha}.md`)
    .sort();
  const ultima = previas.at(-1);
  if (!ultima) return null;
  return { fecha: ultima.replace('.md', ''), contenido: readFileSync(join(dir, ultima), 'utf8') };
}

export function listarNombres(vault: string, tipo: 'personas' | 'proyectos', idioma: Idioma = 'es'): string[] {
  const dir = join(vault, esquemaVault(idioma).carpetas[tipo]);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''));
}

// Tareas "- [ ]" abiertas en Backlogs de proyectos y notas diarias recientes.
export function pendientesAbiertos(vault: string, idioma: Idioma = 'es', limite = 8): string[] {
  const c = esquemaVault(idioma).carpetas;
  const pendientes: string[] = [];
  for (const carpeta of [c.proyectos, c.diario]) {
    const dir = join(vault, carpeta);
    if (!existsSync(dir)) continue;
    const archivos = readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 15);
    for (const archivo of archivos) {
      const texto = readFileSync(join(dir, archivo), 'utf8');
      for (const linea of texto.split('\n')) {
        const m = /^\s*-\s*\[ \]\s+(.*)$/.exec(linea);
        if (m) pendientes.push(`${m[1]} (${archivo.replace('.md', '')})`);
        if (pendientes.length >= limite) return pendientes;
      }
    }
  }
  return pendientes;
}
