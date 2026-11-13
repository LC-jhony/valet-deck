// `valet --version` puede escribir avisos de PHP antes de la versión real.
// Este parser puro deja solo el número, para que la interfaz no muestre el log.
export const parseValetVersion = (text: string): string =>
  text.match(/\bValet\s+v?(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? ''
