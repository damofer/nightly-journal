export interface Logro {
  descripcion: string;
  proyecto?: string;
}

export interface Pendiente {
  descripcion: string;
  proyecto?: string;
}

export interface Interaccion {
  nombre: string;
  detalle: string;
}

export interface Idea {
  proyecto: string;
  idea: string;
}

export interface Extraccion {
  animo: string;
  energia: 'baja' | 'media' | 'alta' | 'desconocida';
  resumen_dia: string;
  etiquetas: string[];
  logros: Logro[];
  pendientes: Pendiente[];
  personas: Interaccion[];
  ideas: Idea[];
}

// Esquema JSON que se pasa a Ollama como `format`: la salida queda
// restringida por gramática, el modelo no puede producir otra estructura.
export const ESQUEMA_EXTRACCION = {
  type: 'object',
  required: ['animo', 'energia', 'resumen_dia', 'etiquetas', 'logros', 'pendientes', 'personas', 'ideas'],
  properties: {
    animo: { type: 'string', description: 'Estado de ánimo en 2-4 palabras; cadena vacía si no se mencionó' },
    energia: { type: 'string', enum: ['baja', 'media', 'alta', 'desconocida'] },
    resumen_dia: { type: 'string', description: 'Resumen del día en 1-3 frases, en primera persona' },
    etiquetas: { type: 'array', items: { type: 'string' }, description: 'Temas del día en minúscula, ej. trabajo, gamedev' },
    logros: {
      type: 'array',
      items: {
        type: 'object',
        required: ['descripcion'],
        properties: {
          descripcion: { type: 'string' },
          proyecto: { type: 'string', description: 'Nombre del proyecto relacionado, si lo hay' },
        },
      },
    },
    pendientes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['descripcion'],
        properties: {
          descripcion: { type: 'string' },
          proyecto: { type: 'string' },
        },
      },
    },
    personas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nombre', 'detalle'],
        properties: {
          nombre: { type: 'string' },
          detalle: { type: 'string', description: 'Qué pasó con esta persona hoy' },
        },
      },
    },
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['proyecto', 'idea'],
        properties: {
          proyecto: { type: 'string' },
          idea: { type: 'string' },
        },
      },
    },
  },
} as const;
