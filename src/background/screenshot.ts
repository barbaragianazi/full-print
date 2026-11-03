// Geometria, planejamento e captura do PNG final (integral ou por faixas), com verificação das
// dimensões reais. Só usa CDP (sem chrome.*): roda também em Node (testes).
//
// Política (ADR 0005): resolução efetiva mínima de 2x, preservando um DPR maior; nunca reduzir a
// escala em silêncio; tentar a captura integral e recorrer a faixas (clip.y, sem perdas) quando os
// limiares conservadores forem excedidos OU a captura integral falhar/vier com dimensões erradas;
// se mesmo assim a qualidade exigida não puder ser mantida, erro claro.
import type { Cdp } from "./cdp.ts";
import { base64ToBlob } from "./blob.ts";
import type { Logger } from "./log.ts";
import { readPngDimensions, stitchStrips, type StripDecoder } from "./png-stitch.ts";
import type { Report } from "./page-prep.ts";

export const TARGET_MIN_SCALE = 2;

// Limiares de PLANEJAMENTO (escolher faixas direto) e de SEGURANÇA. Nenhum é um limite medido do
// Chrome: a auditoria não encontrou ruptura até 63 600 px de altura/161 MP em renderização por
// software. São valores conservadores, ajustáveis (objeto exportado) e validados por testes manuais
// no Chrome instalado (docs/auditoria/05-checklist-fase1.md).
export const limits = {
  /** Acima disto (em px do dispositivo, por lado) vai direto para faixas. */
  singleMaxSidePx: 16_384,
  /** Acima disto (megapixels totais) vai direto para faixas. */
  singleMaxPixels: 100_000_000,
  /** Altura máxima de cada faixa, em px do dispositivo. */
  bandMaxRowsPx: 8_192,
  /** Pixels máximos de cada faixa. */
  bandMaxPixels: 24_000_000,
  /** Teto de segurança de memória/arquivo para o PNG final (erro claro acima disto). */
  absoluteMaxPixels: 400_000_000,
};

export type Strategy = "single" | "bands";

export interface ContentSize {
  width: number;
  height: number;
}

export interface Geometry {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  /** Resolução efetiva pedida: max(2, DPR). */
  effectiveScale: number;
  /** Valor de clip.scale (efetiva / DPR). */
  clipScale: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface ShotResult {
  blob: Blob;
  width: number;
  height: number;
  strategy: Strategy;
  bands: number;
}

export interface ShotContext {
  report: Report;
  log: Logger;
  decodeStrip?: StripDecoder;
}

interface LayoutMetrics {
  contentSize: ContentSize;
  cssContentSize?: ContentSize;
}

export function readPngSize(base64: string): { width: number; height: number } {
  // 24 bytes = assinatura PNG (8) + chunk IHDR (length 4 + tipo 4) + largura (4) + altura (4).
  const header = atob(base64.slice(0, 32));
  if (header.length < 24 || header.slice(0, 8) !== "\x89PNG\r\n\x1a\n") {
    throw new Error("O Chrome retornou dados que não são um PNG válido.");
  }
  const u32 = (offset: number) =>
    (header.charCodeAt(offset) << 24) |
    (header.charCodeAt(offset + 1) << 16) |
    (header.charCodeAt(offset + 2) << 8) |
    header.charCodeAt(offset + 3);
  return { width: u32(16) >>> 0, height: u32(20) >>> 0 };
}

export async function measureContent(cdp: Cdp): Promise<ContentSize> {
  const metrics = await cdp.send<LayoutMetrics>("Page.getLayoutMetrics");
  const css = metrics.cssContentSize ?? metrics.contentSize;
  return { width: Math.ceil(css.width), height: Math.ceil(css.height) };
}

export function geometry(css: ContentSize, dpr: number, minScale = TARGET_MIN_SCALE): Geometry {
  const effectiveScale = Math.max(minScale, dpr);
  return {
    cssWidth: css.width,
    cssHeight: css.height,
    dpr,
    effectiveScale,
    clipScale: effectiveScale / dpr,
    pixelWidth: Math.round(css.width * effectiveScale),
    pixelHeight: Math.round(css.height * effectiveScale),
  };
}

export function assertWithinSafetyCap(g: Geometry): void {
  if (g.pixelWidth * g.pixelHeight > limits.absoluteMaxPixels) {
    throw new Error(
      `A página (${g.cssWidth}×${g.cssHeight}px CSS) geraria uma imagem de ${g.pixelWidth}×${g.pixelHeight}px ` +
        `(${Math.round((g.pixelWidth * g.pixelHeight) / 1e6)} megapixels em ${g.effectiveScale}x), acima do teto de ` +
        `segurança de ${limits.absoluteMaxPixels / 1e6} megapixels. A resolução mínima de ${TARGET_MIN_SCALE}x não pode ` +
        "ser reduzida, então a captura foi recusada antes de começar.",
    );
  }
}

export function planStrategy(g: Geometry): Strategy {
  const tooBig = Math.max(g.pixelWidth, g.pixelHeight) > limits.singleMaxSidePx || g.pixelWidth * g.pixelHeight > limits.singleMaxPixels;
  return tooBig ? "bands" : "single";
}

/** Altura de cada faixa em px CSS: múltipla de 8 para que (altura × escala) seja inteira em escalas de 1/8. */
export function bandCssHeight(g: Geometry): number {
  const rows = Math.min(limits.bandMaxRowsPx, Math.floor(limits.bandMaxPixels / Math.max(1, g.pixelWidth)));
  return Math.max(8, Math.floor(rows / g.effectiveScale / 8) * 8);
}

const within = (actual: number, expected: number, tolerance: number) => Math.abs(actual - expected) <= tolerance;

function qualityError(what: string, actual: { width: number; height: number }, expected: { width: number; height: number }, g: Geometry): Error {
  return new Error(
    `Não foi possível manter a resolução mínima de ${TARGET_MIN_SCALE}x: ${what} tem ${actual.width}×${actual.height}px, ` +
      `mas o esperado era ${expected.width}×${expected.height}px (página de ${g.cssWidth}×${g.cssHeight}px CSS a ${g.effectiveScale}x). ` +
      "A captura foi cancelada para não entregar uma imagem de qualidade inferior.",
  );
}

// Erros que NÃO devem acionar o fallback para faixas (a sessão acabou).
const isFatal = (error: unknown) => error instanceof Error && (error.name === "DetachedError" || /depurador foi desconectado/i.test(error.message));

async function shoot(cdp: Cdp, clip: { x: number; y: number; width: number; height: number; scale: number }) {
  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true,
    clip,
  });
  const size = readPngSize(shot.data);
  return { blob: base64ToBlob(shot.data, "image/png"), ...size };
}

async function captureBands(cdp: Cdp, g: Geometry, ctx: ShotContext): Promise<ShotResult> {
  const { log, report } = ctx;
  const step = bandCssHeight(g);
  const count = Math.ceil(g.cssHeight / step);
  log.info("Captura por faixas", { faixas: count, alturaCssPorFaixa: step, escalaEfetiva: g.effectiveScale });
  const strips: Blob[] = [];
  for (let index = 0; index < count; index++) {
    const y = index * step;
    const height = Math.min(step, g.cssHeight - y);
    report("capturing", 70 + Math.round((index / count) * 14), `Capturando faixa ${index + 1} de ${count}`);
    const strip = await shoot(cdp, { x: 0, y, width: g.cssWidth, height, scale: g.clipScale });
    const expected = { width: g.pixelWidth, height: Math.round(height * g.effectiveScale) };
    if (!within(strip.width, expected.width, 1) || !within(strip.height, expected.height, 1)) {
      throw qualityError(`a faixa ${index + 1} de ${count}`, strip, expected, g);
    }
    strips.push(strip.blob);
  }
  report("capturing", 84, "Montando a imagem final");
  const stitched = await stitchStrips(strips, ctx.decodeStrip);
  if (!within(stitched.width, g.pixelWidth, 1) || !within(stitched.height, g.pixelHeight, count)) {
    throw qualityError("a imagem costurada", stitched, { width: g.pixelWidth, height: g.pixelHeight }, g);
  }
  return { blob: stitched.blob, width: stitched.width, height: stitched.height, strategy: "bands", bands: count };
}

export async function captureImage(cdp: Cdp, g: Geometry, ctx: ShotContext): Promise<ShotResult> {
  const { log } = ctx;
  const planned = planStrategy(g);
  log.info("Plano de captura", {
    estrategia: planned,
    dpr: g.dpr,
    escalaEfetiva: g.effectiveScale,
    clipScale: Math.round(g.clipScale * 1000) / 1000,
    esperado: `${g.pixelWidth}x${g.pixelHeight}`,
    megapixels: Math.round((g.pixelWidth * g.pixelHeight) / 1e4) / 100,
  });

  if (planned === "single") {
    try {
      const full = await shoot(cdp, { x: 0, y: 0, width: g.cssWidth, height: g.cssHeight, scale: g.clipScale });
      if (within(full.width, g.pixelWidth, 1) && within(full.height, g.pixelHeight, 1)) {
        return { blob: full.blob, width: full.width, height: full.height, strategy: "single", bands: 1 };
      }
      log.warn("Captura integral com dimensões divergentes; usando faixas", {
        obtido: `${full.width}x${full.height}`,
        esperado: `${g.pixelWidth}x${g.pixelHeight}`,
      });
    } catch (error) {
      if (isFatal(error)) throw error;
      log.warn("Captura integral falhou; usando faixas", { erro: error instanceof Error ? error.message : String(error) });
    }
  }
  return captureBands(cdp, g, ctx);
}

export { readPngDimensions };
