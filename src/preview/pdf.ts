// Gerador mínimo de PDF a partir do PNG capturado, sem dependências e sem perdas: a imagem é
// fatiada em faixas (limita a memória), cada faixa vira um XObject RGB comprimido com Flate e as
// faixas são empilhadas numa mesma página (sem emendas visíveis). Páginas longas demais para o
// limite de 14400 pt dos leitores de PDF são divididas em várias páginas.

const PT_PER_CSS_PX = 0.75;
const MAX_PAGE_PT = 14_400;
const STRIP_ROWS = 1024; // linhas de pixels por faixa (~10 MB de RGBA em 2500 px de largura)
const OVERLAP_PT = 0.4; // sobreposição entre faixas para evitar frestas por arredondamento

export interface PdfSource {
  blob: Blob;
  /** Largura/altura da página em pixels CSS (define o tamanho do PDF em pontos). */
  cssWidth: number;
  cssHeight: number;
}

class PdfWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  private readonly offsets = new Map<number, number>();
  private readonly encoder = new TextEncoder();
  private nextId = 3; // 1 = catálogo, 2 = lista de páginas

  constructor() {
    this.push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  }

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  private text(value: string): void {
    this.push(this.encoder.encode(value));
  }

  allocate(): number {
    return this.nextId++;
  }

  object(id: number, dictionary: string, stream?: Uint8Array): void {
    this.offsets.set(id, this.length);
    if (stream) {
      this.text(`${id} 0 obj\n<< ${dictionary} /Length ${stream.length} >>\nstream\n`);
      this.push(stream);
      this.text("\nendstream\nendobj\n");
    } else {
      this.text(`${id} 0 obj\n${dictionary}\nendobj\n`);
    }
  }

  finish(pageIds: number[]): Blob {
    this.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    this.object(2, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
    const size = this.nextId;
    const xrefOffset = this.length;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let id = 1; id < size; id++) {
      xref += `${String(this.offsets.get(id) ?? 0).padStart(10, "0")} 00000 n \n`;
    }
    this.text(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return new Blob(this.chunks as BlobPart[], { type: "application/pdf" });
  }
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// RGBA -> RGB composto sobre branco (capturas de página são opacas; o fundo branco cobre o resto).
function toRgb(rgba: Uint8ClampedArray): Uint8Array {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    const alpha = rgba[i + 3] as number;
    if (alpha === 255) {
      rgb[o] = rgba[i] as number;
      rgb[o + 1] = rgba[i + 1] as number;
      rgb[o + 2] = rgba[i + 2] as number;
    } else {
      const inverse = 255 - alpha;
      rgb[o] = ((rgba[i] as number) * alpha + 255 * inverse) / 255;
      rgb[o + 1] = ((rgba[i + 1] as number) * alpha + 255 * inverse) / 255;
      rgb[o + 2] = ((rgba[i + 2] as number) * alpha + 255 * inverse) / 255;
    }
  }
  return rgb;
}

const pt = (value: number) => value.toFixed(2);

export async function buildPdf(source: PdfSource, onProgress?: (fraction: number) => void): Promise<Blob> {
  const bitmap = await createImageBitmap(source.blob);
  try {
    const { width, height } = bitmap;
    const pxPerPt = width / (source.cssWidth * PT_PER_CSS_PX); // pixels do PNG por ponto do PDF
    const pageWidthPt = width / pxPerPt;
    const rowsPerPage = Math.max(1, Math.floor(MAX_PAGE_PT * pxPerPt));
    const writer = new PdfWriter();
    const pageIds: number[] = [];
    const canvas = new OffscreenCanvas(width, STRIP_ROWS);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Não foi possível criar o canvas para gerar o PDF.");

    for (let pageStart = 0; pageStart < height; pageStart += rowsPerPage) {
      const pageRows = Math.min(rowsPerPage, height - pageStart);
      const pageHeightPt = pageRows / pxPerPt;
      let content = "";
      const xobjects: string[] = [];

      for (let offset = 0; offset < pageRows; offset += STRIP_ROWS) {
        const rows = Math.min(STRIP_ROWS, pageRows - offset);
        canvas.height = rows; // redimensionar limpa o canvas
        context.drawImage(bitmap, 0, pageStart + offset, width, rows, 0, 0, width, rows);
        const data = toRgb(context.getImageData(0, 0, width, rows).data);
        const imageId = writer.allocate();
        writer.object(
          imageId,
          `/Type /XObject /Subtype /Image /Width ${width} /Height ${rows} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
          await deflate(data),
        );
        const name = `Im${xobjects.length}`;
        xobjects.push(`/${name} ${imageId} 0 R`);
        const topPt = offset / pxPerPt;
        const heightPt = rows / pxPerPt + OVERLAP_PT;
        content += `q ${pt(pageWidthPt)} 0 0 ${pt(heightPt)} 0 ${pt(pageHeightPt - topPt - heightPt)} cm /${name} Do Q\n`;
        onProgress?.(Math.min(1, (pageStart + offset + rows) / height));
      }

      const contentId = writer.allocate();
      writer.object(contentId, "", new TextEncoder().encode(content));
      const pageId = writer.allocate();
      writer.object(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(pageWidthPt)} ${pt(pageHeightPt)}] ` +
          `/Resources << /XObject << ${xobjects.join(" ")} >> >> /Contents ${contentId} 0 R >>`,
      );
      pageIds.push(pageId);
    }
    return writer.finish(pageIds);
  } finally {
    bitmap.close();
  }
}
