// Resolución de entidades: "Mary", "mary" y "María" deben apuntar a la misma
// nota, no crear tres archivos. El índice de alias vive en el vault.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type TipoEntidad = 'personas' | 'proyectos';

export interface Indice {
  personas: Record<string, string[]>;
  proyectos: Record<string, string[]>;
}

const normalizar = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function rutaIndice(vault: string): string {
  return join(vault, '.indice', 'entidades.json');
}

export function cargarIndice(vault: string): Indice {
  const ruta = rutaIndice(vault);
  if (!existsSync(ruta)) return { personas: {}, proyectos: {} };
  return JSON.parse(readFileSync(ruta, 'utf8')) as Indice;
}

export function guardarIndice(vault: string, indice: Indice): void {
  const ruta = rutaIndice(vault);
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, `${JSON.stringify(indice, null, 2)}\n`, 'utf8');
}

export function resolver(indice: Indice, tipo: TipoEntidad, nombre: string): { canonico: string; esNueva: boolean } {
  const n = normalizar(nombre);
  const grupo = indice[tipo];

  for (const [canonico, alias] of Object.entries(grupo)) {
    if (normalizar(canonico) === n || alias.some(a => normalizar(a) === n)) {
      return { canonico, esNueva: false };
    }
  }

  // coincidencia por contención ("auto battler" ~ "el auto battler"), solo con nombres largos
  for (const [canonico, alias] of Object.entries(grupo)) {
    const nc = normalizar(canonico);
    if (n.length >= 4 && nc.length >= 4 && (nc.includes(n) || n.includes(nc))) {
      alias.push(nombre.trim());
      return { canonico, esNueva: false };
    }
  }

  const canonico = nombre.trim();
  grupo[canonico] = [];
  return { canonico, esNueva: true };
}
