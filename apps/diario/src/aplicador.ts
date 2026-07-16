// El aplicador es la única pieza que escribe en el vault, y es código
// determinista: el LLM propone (Extraccion), esto dispone. Idempotente:
// correr dos veces la misma extracción no duplica nada.
//
// `idiomaVault` decide el esquema de carpetas/secciones (fijado por vault);
// `idiomaUi` decide el idioma de las etiquetas del plan que ve el usuario.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import matter from 'gray-matter';
import type { Extraccion } from './esquema.js';
import { insertarEnSeccion } from './seccion.js';
import { cargarIndice, guardarIndice, resolver } from './entidades.js';
import { esquemaVault, TEXTOS_PLAN, type Idioma } from './idioma.js';
import {
  plantillaDiario,
  plantillaPersona,
  plantillaProyecto,
  rutaDiario,
  rutaPersona,
  rutaProyecto,
} from './vault.js';

export interface ResultadoAplicacion {
  archivos: { ruta: string; detalles: string[] }[];
  omitidos: string[];
}

// Cada item del plan tiene un id estable ("logro:0", "resumen", …) para que
// la UI pueda desmarcarlo y aplicar() lo excluya.
export interface ItemPlan {
  id: string;
  texto: string;
}

class Editor {
  private cambios = new Map<string, string[]>();
  omitidos: string[] = [];

  constructor(private textos: (typeof TEXTOS_PLAN)['es']) {}

  asegurar(ruta: string, plantilla: string): void {
    if (!existsSync(ruta)) {
      writeFileSync(ruta, plantilla, 'utf8');
      this.anotar(ruta, this.textos.creada);
    }
  }

  anotar(ruta: string, detalle: string): void {
    const lista = this.cambios.get(ruta) ?? [];
    if (!lista.includes(detalle)) lista.push(detalle);
    this.cambios.set(ruta, lista);
  }

  insertar(ruta: string, seccion: string, linea: string, detalle: string): void {
    const previo = readFileSync(ruta, 'utf8');
    const r = insertarEnSeccion(previo, seccion, linea);
    if (r.cambiado) {
      writeFileSync(ruta, r.contenido, 'utf8');
      this.anotar(ruta, detalle);
    } else {
      this.omitidos.push(`${detalle} (${this.textos.yaEstaba})`);
    }
  }

  resultado(vault: string): ResultadoAplicacion {
    return {
      archivos: [...this.cambios.entries()].map(([ruta, detalles]) => ({
        ruta: relative(vault, ruta),
        detalles,
      })),
      omitidos: this.omitidos,
    };
  }
}

function actualizarFrontmatterDiario(editor: Editor, ruta: string, ex: Extraccion, idiomaVault: Idioma): void {
  const e = esquemaVault(idiomaVault);
  const fm = e.frontmatter;
  const archivo = matter(readFileSync(ruta, 'utf8'));
  let cambiado = false;

  if (ex.animo.trim() && archivo.data[fm.animo] !== ex.animo.trim()) {
    archivo.data[fm.animo] = ex.animo.trim();
    cambiado = true;
  }
  if (ex.energia !== 'desconocida' && archivo.data[fm.energia] !== e.energias[ex.energia]) {
    archivo.data[fm.energia] = e.energias[ex.energia];
    cambiado = true;
  }
  // clave "tags" (no "etiquetas") y sin espacios: así Obsidian las reconoce
  const crudas: unknown = archivo.data.tags;
  const previas = Array.isArray(crudas) ? crudas.filter((t): t is string => typeof t === 'string') : [];
  const nuevas = ex.etiquetas.map(e2 => e2.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
  const unidas = new Set([...previas, ...nuevas]);
  if (unidas.size !== previas.length) {
    archivo.data.tags = [...unidas];
    cambiado = true;
  }

  if (cambiado) {
    writeFileSync(ruta, matter.stringify(archivo.content, archivo.data), 'utf8');
    editor.anotar(ruta, `${TEXTOS_PLAN[idiomaVault].animo}/tags`);
  }
}

// Quita de la extracción los items que el usuario desmarcó en el plan.
export function filtrarExtraccion(ex: Extraccion, excluir: string[]): Extraccion {
  if (!excluir.length) return ex;
  const fuera = new Set(excluir);
  const filtrada = structuredClone(ex);
  if (fuera.has('animo')) {
    filtrada.animo = '';
    filtrada.energia = 'desconocida';
  }
  if (fuera.has('resumen')) filtrada.resumen_dia = '';
  filtrada.logros = ex.logros.filter((_, i) => !fuera.has(`logro:${i}`));
  filtrada.pendientes = ex.pendientes.filter((_, i) => !fuera.has(`pendiente:${i}`));
  filtrada.personas = ex.personas.filter((_, i) => !fuera.has(`persona:${i}`));
  filtrada.ideas = ex.ideas.filter((_, i) => !fuera.has(`idea:${i}`));
  return filtrada;
}

export function aplicarExtraccion(vault: string, fecha: string, ex: Extraccion, idiomaVault: Idioma = 'es'): ResultadoAplicacion {
  const e = esquemaVault(idiomaVault);
  const t = TEXTOS_PLAN[idiomaVault];
  const editor = new Editor(t);
  const indice = cargarIndice(vault);
  const enlaceHoy = `[[${fecha}]]`;

  const diario = rutaDiario(vault, fecha, idiomaVault);
  editor.asegurar(diario, plantillaDiario(fecha, idiomaVault));
  actualizarFrontmatterDiario(editor, diario, ex, idiomaVault);

  if (ex.resumen_dia.trim()) {
    editor.insertar(diario, e.secciones.resumen, ex.resumen_dia.trim(), t.resumen);
  }

  for (const logro of ex.logros) {
    const desc = logro.descripcion?.trim();
    if (!desc) continue;
    let sufijo = '';
    if (logro.proyecto?.trim()) {
      const { canonico } = resolver(indice, 'proyectos', logro.proyecto);
      const ruta = rutaProyecto(vault, canonico, idiomaVault);
      editor.asegurar(ruta, plantillaProyecto(canonico, idiomaVault));
      editor.insertar(ruta, e.secciones.avances, `- **${fecha}** — ${desc}`, `${e.secciones.avances.toLowerCase()}: ${desc}`);
      sufijo = ` · [[${canonico}]]`;
    }
    editor.insertar(diario, e.secciones.logros, `- [x] ${desc}${sufijo}`, `${t.logro}: ${desc}`);
  }

  for (const pendiente of ex.pendientes) {
    const desc = pendiente.descripcion?.trim();
    if (!desc) continue;
    if (pendiente.proyecto?.trim()) {
      const { canonico } = resolver(indice, 'proyectos', pendiente.proyecto);
      const ruta = rutaProyecto(vault, canonico, idiomaVault);
      editor.asegurar(ruta, plantillaProyecto(canonico, idiomaVault));
      editor.insertar(ruta, e.secciones.backlog, `- [ ] ${desc} (${enlaceHoy})`, `${t.pendiente}: ${desc}`);
    } else {
      editor.insertar(diario, e.secciones.pendientes, `- [ ] ${desc}`, `${t.pendiente}: ${desc}`);
    }
  }

  for (const persona of ex.personas) {
    const nombre = persona.nombre?.trim();
    const detalle = persona.detalle?.trim();
    if (!nombre || !detalle) continue;
    const { canonico } = resolver(indice, 'personas', nombre);
    const ruta = rutaPersona(vault, canonico, idiomaVault);
    editor.asegurar(ruta, plantillaPersona(canonico, idiomaVault));
    editor.insertar(ruta, e.secciones.interacciones, `- **${fecha}** — ${detalle}`, `${t.interaccion} ${canonico}`);
    editor.insertar(diario, e.secciones.relacionado, `- [[${canonico}]] — ${detalle}`, `${e.secciones.relacionado.toLowerCase()}: ${canonico}`);
  }

  for (const idea of ex.ideas) {
    const proyecto = idea.proyecto?.trim();
    const texto = idea.idea?.trim();
    if (!proyecto || !texto) continue;
    const { canonico } = resolver(indice, 'proyectos', proyecto);
    const ruta = rutaProyecto(vault, canonico, idiomaVault);
    editor.asegurar(ruta, plantillaProyecto(canonico, idiomaVault));
    editor.insertar(ruta, e.secciones.ideas, `- ${texto} (${enlaceHoy})`, `${t.idea}: ${texto}`);
    editor.insertar(diario, e.secciones.relacionado, `- ${t.idea} [[${canonico}]] — ${texto}`, `${t.idea}-rel: ${canonico}`);
  }

  guardarIndice(vault, indice);
  return editor.resultado(vault);
}

export interface Adjunto {
  nombre: string;
  tipo: 'imagen' | 'documento';
}

// Enlaza los archivos adjuntos de la sesión en la nota diaria. Las imágenes
// van como embed (![[...]]) para que Obsidian las muestre inline.
export function aplicarAdjuntos(vault: string, fecha: string, adjuntos: Adjunto[], idiomaVault: Idioma = 'es'): ResultadoAplicacion {
  const e = esquemaVault(idiomaVault);
  const editor = new Editor(TEXTOS_PLAN[idiomaVault]);
  if (adjuntos.length) {
    const diario = rutaDiario(vault, fecha, idiomaVault);
    editor.asegurar(diario, plantillaDiario(fecha, idiomaVault));
    for (const adjunto of adjuntos) {
      const ruta = `${e.carpetas.adjuntos}/${fecha}/${adjunto.nombre}`;
      const enlace = adjunto.tipo === 'imagen' ? `- ![[${ruta}]]` : `- [[${ruta}]]`;
      editor.insertar(diario, e.secciones.adjuntos, enlace, `${TEXTOS_PLAN[idiomaVault].adjunto}: ${adjunto.nombre}`);
    }
  }
  return editor.resultado(vault);
}

// Vista previa sin escribir nada: qué haría el aplicador con esta extracción.
// Los ids son estables respecto a los índices ORIGINALES de la extracción,
// para que la UI pueda excluir items concretos al aplicar.
export function describirPlan(
  vault: string,
  fecha: string,
  ex: Extraccion,
  idiomaVault: Idioma = 'es',
  idiomaUi: Idioma = idiomaVault
): ItemPlan[] {
  const e = esquemaVault(idiomaVault);
  const t = TEXTOS_PLAN[idiomaUi];
  const indice = structuredClone(cargarIndice(vault));
  const plan: ItemPlan[] = [];
  const marca = (esNueva: boolean) => (esNueva ? t.nueva : '');
  const notaDiaria = `${e.carpetas.diario}/${fecha}.md`;

  if (ex.animo.trim()) {
    plan.push({ id: 'animo', texto: `${t.animo} "${ex.animo.trim()}" · ${t.energia} ${e.energias[ex.energia]} → ${notaDiaria}` });
  }
  if (ex.resumen_dia.trim()) plan.push({ id: 'resumen', texto: `${t.resumen} → ${notaDiaria}` });

  ex.logros.forEach((logro, i) => {
    if (!logro.descripcion?.trim()) return;
    let destino = notaDiaria;
    if (logro.proyecto?.trim()) {
      const r = resolver(indice, 'proyectos', logro.proyecto);
      destino += ` + ${e.carpetas.proyectos}/${r.canonico}.md${marca(r.esNueva)}`;
    }
    plan.push({ id: `logro:${i}`, texto: `${t.logro} "${logro.descripcion.trim()}" → ${destino}` });
  });
  ex.pendientes.forEach((pendiente, i) => {
    if (!pendiente.descripcion?.trim()) return;
    if (pendiente.proyecto?.trim()) {
      const r = resolver(indice, 'proyectos', pendiente.proyecto);
      plan.push({
        id: `pendiente:${i}`,
        texto: `${t.pendiente} "${pendiente.descripcion.trim()}" → ${e.carpetas.proyectos}/${r.canonico}.md${marca(r.esNueva)}`,
      });
    } else {
      plan.push({ id: `pendiente:${i}`, texto: `${t.pendiente} "${pendiente.descripcion.trim()}" → ${notaDiaria}` });
    }
  });
  ex.personas.forEach((persona, i) => {
    if (!persona.nombre?.trim() || !persona.detalle?.trim()) return;
    const r = resolver(indice, 'personas', persona.nombre);
    plan.push({
      id: `persona:${i}`,
      texto: `${t.interaccion} ${r.canonico} → ${e.carpetas.personas}/${r.canonico}.md${marca(r.esNueva)}`,
    });
  });
  ex.ideas.forEach((idea, i) => {
    if (!idea.proyecto?.trim() || !idea.idea?.trim()) return;
    const r = resolver(indice, 'proyectos', idea.proyecto);
    plan.push({
      id: `idea:${i}`,
      texto: `${t.idea} "${idea.idea.trim()}" → ${e.carpetas.proyectos}/${r.canonico}.md${marca(r.esNueva)}`,
    });
  });
  return plan;
}
