// Post-procesamiento determinista de la extracción: los modelos pequeños a
// veces escriben "(proyecto: X)" dentro de la descripción en vez de llenar el
// campo "proyecto". Aquí se corrige con código, no con más prompt.

import type { Extraccion } from './esquema.js';

const normalizar = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// "(proyecto: X)" o "[project X]" incrustado en la descripción; tolera
// paréntesis sin cerrar, que los modelos también producen.
const RE_ETIQUETA_PROYECTO = /\s*[([]\s*(?:proyecto|project):?\s*([^)\]]+?)\s*[)\]]?\s*$/i;

interface ConProyecto {
  descripcion?: string;
  idea?: string;
  proyecto?: string;
}

function corregirItem(item: ConProyecto, campo: 'descripcion' | 'idea', proyectosConocidos: string[]): void {
  const texto = item[campo];
  if (!texto) return;

  const m = RE_ETIQUETA_PROYECTO.exec(texto);
  if (m) {
    item[campo] = texto.replace(RE_ETIQUETA_PROYECTO, '').trim();
    if (!item.proyecto?.trim()) item.proyecto = m[1].trim();
  }

  if (!item.proyecto?.trim()) {
    const textoNorm = normalizar(item[campo] ?? '');
    const conocido = proyectosConocidos.find(p => {
      const pNorm = normalizar(p);
      return pNorm.length >= 4 && textoNorm.includes(pNorm);
    });
    if (conocido) item.proyecto = conocido;
  }
}

export function normalizarExtraccion(ex: Extraccion, proyectosConocidos: string[]): void {
  for (const logro of ex.logros) corregirItem(logro, 'descripcion', proyectosConocidos);
  for (const pendiente of ex.pendientes) corregirItem(pendiente, 'descripcion', proyectosConocidos);
  for (const idea of ex.ideas) corregirItem(idea, 'idea', proyectosConocidos);

  // ánimo debe ser corto; si el modelo devolvió una frase, corta en la primera coma o punto
  if (ex.animo.split(/\s+/).length > 5) {
    ex.animo = ex.animo.split(/[,.;]/)[0].trim();
  }
}
