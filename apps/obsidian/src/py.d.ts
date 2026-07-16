// Los .py se importan como texto (esbuild loader 'text'): el asistente de
// voz escribe el sidecar a disco desde el propio bundle.
declare module '*.py' {
  const contenido: string;
  export default contenido;
}
