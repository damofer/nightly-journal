// Racha de noches seguidas escribiendo y niveles de energía recientes
// (para el chip 🔥 y la mini-gráfica del encabezado). Solo lee el vault.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { esquemaVault, NIVEL_ENERGIA, type Idioma } from './idioma.js';

export function diaAnterior(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Noches consecutivas con nota diaria, contando hacia atrás. Si hoy aún no
// tiene nota, la racha sigue viva desde ayer (estás a punto de escribirla).
export function racha(vault: string, fecha: string, idiomaVault: Idioma = 'es'): number {
  const dir = join(vault, esquemaVault(idiomaVault).carpetas.diario);
  let dia = fecha;
  if (!existsSync(join(dir, `${dia}.md`))) dia = diaAnterior(dia);
  let noches = 0;
  while (existsSync(join(dir, `${dia}.md`))) {
    noches++;
    dia = diaAnterior(dia);
  }
  return noches;
}

export interface EnergiaDia {
  fecha: string;
  nivel: number; // 0 = sin dato, 1 baja, 2 media, 3 alta
}

// Energía de los últimos `dias` días (para la mini-gráfica). Tolera vaults
// en cualquiera de los dos idiomas gracias a NIVEL_ENERGIA.
export function energiasRecientes(vault: string, fecha: string, idiomaVault: Idioma = 'es', dias = 7): EnergiaDia[] {
  const e = esquemaVault(idiomaVault);
  const dir = join(vault, e.carpetas.diario);
  const fechas: string[] = [];
  let dia = fecha;
  for (let i = 0; i < dias; i++) {
    fechas.unshift(dia);
    dia = diaAnterior(dia);
  }
  return fechas.map(f => {
    const ruta = join(dir, `${f}.md`);
    if (!existsSync(ruta)) return { fecha: f, nivel: 0 };
    try {
      const datos = matter(readFileSync(ruta, 'utf8')).data;
      const valor = String(datos[e.frontmatter.energia] ?? datos.energia ?? datos.energy ?? '').toLowerCase();
      return { fecha: f, nivel: NIVEL_ENERGIA[valor] ?? 0 };
    } catch {
      return { fecha: f, nivel: 0 };
    }
  });
}
