// Decodificador de faixas para os testes em Node (a extensão usa createImageBitmap/OffscreenCanvas).
import { decodePng } from "./png.mjs";

export async function nodeDecodeStrip(blob) {
  const png = decodePng(Buffer.from(await blob.arrayBuffer()));
  const rgba = new Uint8Array(png.width * png.height * 4);
  for (let i = 0, o = 0; i < png.data.length; i += png.channels, o += 4) {
    rgba[o] = png.data[i]; rgba[o + 1] = png.data[i + 1]; rgba[o + 2] = png.data[i + 2];
    rgba[o + 3] = png.channels === 4 ? png.data[i + 3] : 255;
  }
  return { width: png.width, height: png.height, rgba };
}
