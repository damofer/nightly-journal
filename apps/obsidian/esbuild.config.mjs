// Bundle del plugin: src/main.ts (+ el núcleo de ../diario/src, que esbuild
// resuelve nativamente aunque los imports usen especificadores .js) → main.js
// CommonJS con `obsidian` y los builtins de Node externos.
//
//   npm run dev     → watch; si OBSIDIAN_TEST_VAULT está seteado, escribe
//                     main.js directo en el plugin folder del vault de prueba
//   npm run build   → producción + asserts del bundle

import { readFileSync } from 'node:fs';
import esbuild from 'esbuild';

const prod = process.argv.includes('production');
const vault = process.env.OBSIDIAN_TEST_VAULT;
const outfile = !prod && vault ? `${vault}/.obsidian/plugins/nightly-journal/main.js` : 'main.js';

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs', // Obsidian carga main.js como CommonJS
  platform: 'node', // externaliza los builtins node:* automáticamente
  target: 'es2022',
  external: ['obsidian', 'electron'],
  // el sidecar de voz viaja DENTRO del bundle como texto: el asistente de
  // voz lo escribe a disco al configurar (la release solo lleva main.js)
  loader: { '.py': 'text' },
  outfile,
  sourcemap: prod ? false : 'inline',
  minify: false, // legible: requisito práctico para la revisión de comunidad
  logLevel: 'info',
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
  // asserts: nada de node:sea (config.ts no debe colarse) y obsidian externo
  const bundle = readFileSync(outfile, 'utf8');
  if (bundle.includes('node:sea')) {
    console.error('✗ el bundle contiene node:sea — algún import de config.js dejó de ser type-only');
    process.exit(1);
  }
  if (!bundle.includes('require("obsidian")')) {
    console.error('✗ el bundle no referencia obsidian como externo');
    process.exit(1);
  }
  console.log(`✓ bundle verificado: sin node:sea, obsidian externo (${(bundle.length / 1024).toFixed(0)} KB)`);
} else {
  await ctx.watch();
  console.log(`esbuild en watch → ${outfile}`);
}
