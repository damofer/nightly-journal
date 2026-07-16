// Entrada de consola con cola: las líneas que llegan mientras el modelo está
// generando (o todas de golpe, si vienen por pipe) se conservan hasta que se
// pidan, en vez de perderse como pasa con readline.question a secas.

import { createInterface } from 'node:readline';

export interface Consola {
  preguntar(prompt: string): Promise<string>;
  cerrar(): void;
}

export function crearConsola(): Consola {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const cola: string[] = [];
  let esperando: ((linea: string) => void) | null = null;
  let cerrado = false;

  rl.on('line', linea => {
    if (esperando) {
      const resolver = esperando;
      esperando = null;
      resolver(linea);
    } else {
      cola.push(linea);
    }
  });

  rl.on('close', () => {
    cerrado = true;
    if (esperando) {
      const resolver = esperando;
      esperando = null;
      resolver('/fin');
    }
  });

  return {
    preguntar(prompt: string): Promise<string> {
      if (cola.length) {
        const linea = cola.shift()!;
        process.stdout.write(`${prompt}${linea}\n`);
        return Promise.resolve(linea);
      }
      if (cerrado) return Promise.resolve('/fin');
      process.stdout.write(prompt);
      return new Promise(resolver => {
        esperando = resolver;
      });
    },
    cerrar: () => rl.close(),
  };
}
