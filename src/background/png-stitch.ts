// Costura de faixas PNG verticais em um único PNG, sem perdas e em streaming: cada faixa é decodificada,
// filtrada (Sub) e enviada a um CompressionStream("deflate"); o resultado é montado em chunks IDAT.
// Memória limitada a uma faixa por vez (não cria um canvas do tamanho da página inteira), então não
// depende dos limites de dimensão do canvas. Sem chrome.*: roda no service worker, em páginas e em Node
// (com um decodificador injetado).

export interface DecodedStrip {
  width: number;
  height: number;
  /** RGBA de 8 bits, linha a linha, sem pré-multiplicação. */
  rgba: Uint8Array | Uint8ClampedArray;
}
export type StripDecoder = (blob: Blob) => Promise<DecodedStrip>;

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ROWS_PER_BATCH = 128;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function readPngDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const head = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  if (head.length < 24 || SIGNATURE.some((byte, i) => head[i] !== byte)) {
    throw new Error("Os dados retornados pelo Chrome não são um PNG válido.");
  }
  const view = new DataView(head.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Decodificador padrão (páginas e service workers): createImageBitmap + OffscreenCanvas.
export const decodeWithBrowser: StripDecoder = async (blob) => {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Não foi possível criar o canvas para costurar as faixas.");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, rgba: image.data };
  } finally {
    bitmap.close();
  }
};

export interface StitchResult {
  blob: Blob;
  width: number;
  height: number;
}

export async function stitchStrips(
  strips: Blob[],
  decode: StripDecoder = decodeWithBrowser,
  onProgress?: (done: number, total: number) => void,
): Promise<StitchResult> {
  if (strips.length === 0) throw new Error("Nenhuma faixa para costurar.");
  const sizes = await Promise.all(strips.map(readPngDimensions));
  const width = (sizes[0] as { width: number }).width;
  if (sizes.some((size) => size.width !== width)) throw new Error("As faixas têm larguras diferentes.");
  const height = sizes.reduce((sum, size) => sum + size.height, 0);

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // profundidade
  header[9] = 6; // RGBA

  const parts: Uint8Array[] = [SIGNATURE, chunk("IHDR", header)];
  const compressor = new CompressionStream("deflate");
  const writer = compressor.writable.getWriter();
  const pump = (async () => {
    const reader = compressor.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(chunk("IDAT", value));
    }
  })();

  const rowBytes = width * 4;
  try {
    for (let index = 0; index < strips.length; index++) {
      const strip = await decode(strips[index] as Blob);
      const expected = sizes[index] as { width: number; height: number };
      if (strip.width !== expected.width || strip.height !== expected.height) {
        throw new Error("A decodificação da faixa retornou dimensões diferentes das do PNG.");
      }
      for (let row = 0; row < strip.height; row += ROWS_PER_BATCH) {
        const rows = Math.min(ROWS_PER_BATCH, strip.height - row);
        const raw = new Uint8Array(rows * (1 + rowBytes));
        for (let r = 0; r < rows; r++) {
          const src = (row + r) * rowBytes;
          const dst = r * (1 + rowBytes);
          raw[dst] = 1; // filtro Sub
          for (let i = 0; i < rowBytes; i++) {
            const left = i >= 4 ? (strip.rgba[src + i - 4] as number) : 0;
            raw[dst + 1 + i] = ((strip.rgba[src + i] as number) - left) & 255;
          }
        }
        await writer.write(raw);
      }
      onProgress?.(index + 1, strips.length);
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await pump.catch(() => {});
    throw error;
  }
  await pump;
  parts.push(chunk("IEND", new Uint8Array(0)));
  return { blob: new Blob(parts as BlobPart[], { type: "image/png" }), width, height };
}
