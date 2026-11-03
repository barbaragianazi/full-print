// Decodificador PNG mínimo (8 bits, RGB/RGBA, sem entrelaçamento) para medir fidelidade por pixel.
import { inflateSync } from "node:zlib";

export function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("não é PNG");
  let offset = 8;
  let header;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  if (!header || header.depth !== 8 || header.interlace !== 0 || ![2, 6].includes(header.colorType)) {
    throw new Error(`PNG não suportado pelo decodificador de teste: ${JSON.stringify(header)}`);
  }
  const channels = header.colorType === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? data[dst + i - channels] : 0;
      const b = y > 0 ? data[dst - stride + i] : 0;
      const c = i >= channels && y > 0 ? data[dst - stride + i - channels] : 0;
      let value = raw[src + i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[dst + i] = value & 255;
    }
  }
  return { width: header.width, height: header.height, channels, data };
}

export const pixelAt = (png, x, y) => {
  const i = (y * png.width + x) * png.channels;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};

export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const close = (a, b, tolerance = 10) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

// Fração dos pontos amostrados de cada bloco esperado que têm a cor certa.
// blocks: [{ y, h, color, label }] em px CSS; scale = pixels do PNG por px CSS.
export function scoreBlocks(png, blocks, scale) {
  const points = [[0.7, 0.5], [0.85, 0.2], [0.8, 0.8], [0.95, 0.5]];
  const failed = [];
  let ok = 0;
  for (const block of blocks) {
    let good = true;
    for (const [fx, fy] of points) {
      const x = Math.min(png.width - 1, Math.floor(fx * png.width));
      const y = Math.floor((block.y + fy * block.h) * scale);
      if (y >= png.height || !close(pixelAt(png, x, y), hexToRgb(block.color))) { good = false; break; }
    }
    if (good) ok++;
    else failed.push(block.label);
  }
  return { ok, total: blocks.length, failed };
}

// Linhas (em px do PNG) em que uma coluna tem a cor dada, agrupadas em faixas contínuas.
export function colorBands(png, x, color, tolerance = 10) {
  const bands = [];
  let start = -1;
  const target = hexToRgb(color);
  for (let y = 0; y < png.height; y++) {
    const hit = close(pixelAt(png, x, y), target, tolerance);
    if (hit && start < 0) start = y;
    if (!hit && start >= 0) { bands.push([start, y - 1]); start = -1; }
  }
  if (start >= 0) bands.push([start, png.height - 1]);
  return bands;
}
