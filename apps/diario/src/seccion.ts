// Edición quirúrgica de secciones "## Título" en markdown generado por la app.
// Localiza por escaneo de líneas consciente de bloques de código y hace splice:
// el resto del archivo se preserva byte a byte (las notas son ATX generadas aquí).

const normalizar = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

interface Rango {
  encabezado: number;
  inicio: number;
  fin: number; // exclusivo
}

function localizar(lineas: string[], titulo: string): Rango | null {
  let enCerca = false;
  let encabezado = -1;
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    if (/^(```|~~~)/.test(linea.trim())) {
      enCerca = !enCerca;
      continue;
    }
    if (enCerca) continue;
    if (encabezado === -1) {
      const m = /^##\s+(.+?)\s*$/.exec(linea);
      if (m && normalizar(m[1]) === normalizar(titulo)) encabezado = i;
    } else if (/^#{1,2}\s/.test(linea)) {
      return { encabezado, inicio: encabezado + 1, fin: i };
    }
  }
  return encabezado === -1 ? null : { encabezado, inicio: encabezado + 1, fin: lineas.length };
}

export interface ResultadoInsercion {
  contenido: string;
  cambiado: boolean;
}

// Inserta `linea` al final de la sección; crea la sección si no existe; no duplica.
export function insertarEnSeccion(contenido: string, titulo: string, linea: string): ResultadoInsercion {
  const lineas = contenido.split('\n');
  const rango = localizar(lineas, titulo);

  if (!rango) {
    const base = contenido.endsWith('\n') ? contenido : `${contenido}\n`;
    return { contenido: `${base}\n## ${titulo}\n\n${linea}\n`, cambiado: true };
  }

  const cuerpo = lineas.slice(rango.inicio, rango.fin);
  if (cuerpo.some(l => l.trim() === linea.trim())) return { contenido, cambiado: false };

  let pos = rango.inicio;
  for (let i = rango.inicio; i < rango.fin; i++) {
    if (lineas[i].trim() !== '') pos = i + 1;
  }

  const nuevas = [...lineas];
  if (pos === rango.inicio) {
    nuevas.splice(rango.inicio, 0, '', linea);
  } else {
    nuevas.splice(pos, 0, linea);
  }
  return { contenido: nuevas.join('\n'), cambiado: true };
}
