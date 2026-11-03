// Converte o base64 do CDP em Blob sem criar uma segunda cópia inteira em memória: decodifica em
// pedaços de 4 MiB (múltiplo de 4, cada pedaço é base64 válido por si só).
const CHUNK_CHARS = 4 * 1024 * 1024;

export function base64ToBlob(base64: string, type: string): Blob {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let start = 0; start < base64.length; start += CHUNK_CHARS) {
    const binary = atob(base64.slice(start, start + CHUNK_CHARS));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    parts.push(bytes);
  }
  return new Blob(parts, { type });
}
