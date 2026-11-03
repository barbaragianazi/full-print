// Captura CDP de página inteira em PNG com resolução mínima de 2x (preparação + captura + restauração).
// Só usa CDP (sem chrome.*), então também roda em Node (scripts/cdp-smoke.mjs, auditoria, testes).
import type { Cdp } from "./cdp.ts";
import { Stopwatch, type Logger } from "./log.ts";
import {
  DEFAULT_TUNING,
  evaluate,
  goToBottom,
  installProbe,
  logSettle,
  pageInfo,
  readScroll,
  removeProbe,
  scrollDown,
  scrollTo,
  scrollUpTo,
  settle,
  sleep,
  visibilityState,
  waitForFonts,
  type PageInfo,
  type Report,
  type ScrollPosition,
  type SettleResult,
  type Tuning,
} from "./page-prep.ts";
import { decide, readSignals, resetMutations, verifyAtTop, type Decision, type PageSignals, type StrategyMode } from "./signals.ts";
import type { StripDecoder } from "./png-stitch.ts";
import {
  assertWithinSafetyCap,
  captureImage,
  geometry,
  measureContent,
  planStrategy,
  type Strategy,
} from "./screenshot.ts";

export { limits, TARGET_MIN_SCALE } from "./screenshot.ts";
export { BASELINE_V040, DEFAULT_TUNING } from "./page-prep.ts";
export type { Tuning } from "./page-prep.ts";

export interface CaptureContext {
  report: Report;
  log: Logger;
  /** Traz a aba à frente (extensão: FocusGuard). Chamado só quando a página está oculta. */
  ensureVisible?: () => Promise<void>;
  /** Decodificador de faixas (testes em Node). */
  decodeStrip?: StripDecoder;
  /** Parâmetros de tempo/estratégia (padrão: DEFAULT_TUNING; BASELINE_V040 = comportamento da v0.4.0). */
  tuning?: Tuning;
}

export interface CapturedImage {
  blob: Blob;
  /** Pixels do PNG. */
  width: number;
  height: number;
  /** Tamanho da página em pixels CSS. */
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  effectiveScale: number;
  strategy: Strategy;
  bands: number;
  /** Preparação usada: direct (só rolagem de sondagem) ou full (rolagem + espera + congelamento). */
  mode: StrategyMode;
}

interface SnapshotSummary {
  total: number;
  translucent: number;
  sample: unknown[];
}

interface DiffSummary {
  changed: number;
  sample: unknown[];
}

async function step(log: Logger, label: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    // a restauração nunca deve mascarar o erro original nem impedir os demais passos
    log.warn(`Falha ao ${label}`, { error: error instanceof Error ? error.message : String(error) });
  }
}

// Abas em segundo plano pausam rAF/animações: a captura sairia "com sucesso" porém degradada.
// Se a página estiver oculta, pede à extensão para trazê-la à frente; se não der, erro claro.
async function requireVisible(cdp: Cdp, ctx: CaptureContext, moment: string): Promise<void> {
  const { log } = ctx;
  let state = await visibilityState(cdp);
  if (state === "visible") return;
  log.warn("Aba em segundo plano", { momento: moment, estado: state });
  if (ctx.ensureVisible) {
    try {
      await ctx.ensureVisible();
    } catch (error) {
      log.warn("Falha ao trazer a aba à frente", { erro: error instanceof Error ? error.message : String(error) });
    }
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    state = await visibilityState(cdp);
    if (state === "visible") {
      log.info("Aba visível", { momento: moment });
      await sleep(150); // dá tempo para o rAF retomar
      return;
    }
    await sleep(100);
  }
  throw new Error(
    "A aba está em segundo plano e não pôde ser trazida à frente. Mantenha a aba visível durante a captura e tente novamente.",
  );
}

async function restorePage(
  cdp: Cdp,
  ctx: CaptureContext,
  state: { original: ScrollPosition | null; scrolled: boolean; frozen: number; info: PageInfo | null; quietMs: number },
): Promise<void> {
  const { log, report } = ctx;
  const { original, scrolled, frozen, info } = state;
  report("restoring", 86, "Restaurando a página");
  await step(log, "ler os redimensionamentos", async () => {
    const resize = await evaluate<unknown>(cdp, "window.__fp.resize");
    log.info("Redimensionamentos da janela durante a captura", { resize });
  });

  if (original && scrolled) {
    await step(log, "restaurar a rolagem", async () => {
      if (frozen > 0 || info?.gsap) {
        // Caminho natural: fim da página -> religa triggers -> sobe até a posição original, para
        // a própria página reaplicar seu estado (ex.: onLeaveBack reescondendo o que está abaixo).
        await goToBottom(cdp);
        await sleep(200);
        if (frozen > 0) {
          const count = await evaluate<number>(cdp, "window.__fp.unfreeze()");
          log.info("Triggers religados", { count });
        }
        report("restoring", 90, "Voltando à posição original");
        await scrollUpTo(cdp, original);
      } else {
        await scrollTo(cdp, original);
      }
      logSettle(log, "Após restaurar", await settle(cdp, state.quietMs, 5_000));
    });
    await step(log, "comparar o estado restaurado", async () => {
      const after = await evaluate<SnapshotSummary>(cdp, 'window.__fp.snapshot("after")');
      const diff = await evaluate<DiffSummary>(cdp, 'window.__fp.diff("before", "after")');
      const data = { elementsCompared: after.total, changed: diff.changed, sample: diff.sample };
      if (diff.changed > 0) log.warn("Estado restaurado difere do original", data);
      else log.info("Estado restaurado idêntico ao original", data);
    });
  }
  await step(log, "remover o código de apoio da página", () => removeProbe(cdp));
  await step(log, "desativar o domínio Page", () => cdp.send("Page.disable"));
  report("restoring", 95, "Página restaurada");
}

// Espera de assentamento com teto GLOBAL sobre o tempo desperdiçado: esperas que terminam assentadas são
// úteis e não contam; só as que estouram o limite (animações que nunca terminam) consomem o orçamento.
class SettleBudget {
  private wasted = 0;
  private readonly tuning: Tuning;
  constructor(tuning: Tuning) {
    this.tuning = tuning;
  }

  async settle(cdp: Cdp, maxMs: number): Promise<SettleResult> {
    const { wasteBudgetMs, quietMs } = this.tuning;
    let cap = maxMs;
    if (wasteBudgetMs !== null) cap = Math.min(maxMs, Math.max(1_000, wasteBudgetMs - this.wasted));
    const result = await settle(cdp, quietMs, cap);
    if (!result.settled) this.wasted += result.ms;
    return result;
  }
}

// Executa preparação + captura e SEMPRE restaura a página. O detach do debugger (e a restauração do
// foco da aba/janela) é responsabilidade de quem criou a sessão.
export async function capturePage(
  cdp: Cdp,
  ctx: CaptureContext,
  onOriginalScroll?: (scroll: ScrollPosition) => Promise<void>,
): Promise<CapturedImage> {
  const { report, log } = ctx;
  const tuning = ctx.tuning ?? DEFAULT_TUNING;
  const state = { original: null as ScrollPosition | null, scrolled: false, frozen: 0, info: null as PageInfo | null, quietMs: tuning.quietMs };
  const watch = new Stopwatch();
  const budget = new SettleBudget(tuning);
  let mode: StrategyMode = "full";
  try {
    report("preparing", 2, "Preparando a página");
    await cdp.send("Page.enable");
    await installProbe(cdp);
    state.original = await readScroll(cdp);
    await onOriginalScroll?.(state.original);
    state.info = await pageInfo(cdp);
    log.info("Página", { ...state.info, originalScroll: state.original });
    await requireVisible(cdp, ctx, "início");

    // Verificação precoce (antes de gastar segundos de preparação): o teto de segurança nunca
    // reduz a escala; recusa cedo e com mensagem clara. O tamanho é revalidado após a rolagem.
    const early = geometry(await measureContent(cdp), state.info.dpr);
    assertWithinSafetyCap(early);
    log.info("Geometria inicial", {
      css: `${early.cssWidth}x${early.cssHeight}`,
      escalaEfetiva: early.effectiveScale,
      esperado: `${early.pixelWidth}x${early.pixelHeight}`,
      estrategiaPrevista: planStrategy(early),
    });

    await waitForFonts(cdp);
    await resetMutations(cdp);
    const initialSettle = await budget.settle(cdp, 3_000);
    logSettle(log, "Estado inicial", initialSettle);
    const before = await evaluate<SnapshotSummary>(cdp, 'window.__fp.snapshot("before")');
    log.info("Estado inicial da página", { elements: before.total, translucent: before.translucent });
    // Sinais de repouso: base para decidir se a rolagem de preparação provoca alguma reação.
    let initialSignals: PageSignals | undefined;
    let baselineMutations: number | undefined;
    if (tuning.adaptive) {
      try {
        initialSignals = await readSignals(cdp);
        baselineMutations = initialSignals.mutations;
        await resetMutations(cdp);
        log.info("Sinais iniciais", { ...initialSignals });
      } catch (error) {
        log.warn("Falha ao ler os sinais iniciais", { erro: error instanceof Error ? error.message : String(error) });
      }
    }
    watch.lap("preparo");

    // 1) Percorre a página para disparar lazy loading e as animações da própria página.
    const scrollWholePage = async () => {
      report("scrolling", 8, "Rolando a página");
      state.scrolled = true;
      const result = await scrollDown(
        cdp,
        (percent) => report("scrolling", 8 + Math.round(percent * 0.47), `Rolando a página (${percent}%)`),
        tuning,
      );
      log.info("Rolagem concluída", { ...result });
      if (result.truncated) log.warn("Rolagem interrompida pelo limite de segurança (página muito longa)");
      watch.lap("rolagem");
      await requireVisible(cdp, ctx, "após a rolagem");
      return result;
    };
    const summary = await scrollWholePage();

    // 1b) Decisão: a rolagem foi a sonda. Nenhuma reação => captura direta; qualquer dúvida => completa.
    let decision: Decision = { mode: "full", reasons: [tuning.adaptive ? "sinais inconclusivos" : "estratégia adaptativa desligada"] };
    let afterScroll: PageSignals | undefined;
    if (tuning.adaptive) {
      try {
        await waitForFonts(cdp);
        afterScroll = await readSignals(cdp);
        decision = decide({ initial: initialSignals, initialSettled: initialSettle.settled, baselineMutations, afterScroll, scrollTruncated: summary.truncated });
      } catch (error) {
        log.warn("Falha ao ler os sinais após a rolagem", { erro: error instanceof Error ? error.message : String(error) });
      }
      log.info("Decisão de estratégia", { modo: decision.mode, motivos: decision.reasons, sinaisAposRolagem: afterScroll });
      watch.lap("decisão");
    }

    if (decision.mode === "direct" && afterScroll) {
      // Caminho direto: volta ao topo e confere que nada reagiu; reprovou => estratégia completa (v0.4.0).
      report("settling", 60, "Voltando ao topo");
      await scrollTo(cdp, { x: 0, y: 0 });
      await sleep(150);
      await requireVisible(cdp, ctx, "volta ao topo");
      const atTop = await readSignals(cdp);
      const cap = await evaluate<SnapshotSummary>(cdp, 'window.__fp.snapshot("capture")');
      const diff = await evaluate<DiffSummary>(cdp, 'window.__fp.diff("before", "capture")');
      const failures = verifyAtTop(afterScroll, atTop, diff.changed);
      watch.lap("verificação no topo");
      if (failures.length === 0) {
        mode = "direct";
        log.info("Captura direta confirmada", { elements: cap.total, translucent: cap.translucent });
      } else {
        log.warn("Verificação no topo reprovou a captura direta: usando a estratégia completa", { motivos: failures, diff: diff.sample });
        decision = { mode: "full", reasons: failures };
        await scrollWholePage();
      }
    }

    if (mode === "full") {
      // 2) Espera o que foi disparado terminar e congela os triggers de replay.
      report("settling", 56, "Aguardando animações");
      logSettle(log, "Fim da rolagem", await budget.settle(cdp, 8_000));
      await waitForFonts(cdp);
      const freeze = await evaluate<{ frozen: number; kept: number }>(cdp, "window.__fp.freeze()");
      state.frozen = freeze.frozen;
      log.info("ScrollTriggers", { ...freeze, total: state.info.scrollTrigger });
      watch.lap("animações após a rolagem");

      // 3) Volta ao topo (a hero pode reanimar) e espera assentar antes de capturar.
      await scrollTo(cdp, { x: 0, y: 0 });
      await sleep(150);
      await requireVisible(cdp, ctx, "volta ao topo");
      report("settling", 64, "Voltando ao topo");
      let top = await budget.settle(cdp, 8_000);
      logSettle(log, "Topo", top);
      if (!top.settled) {
        top = await budget.settle(cdp, 3_000);
        logSettle(log, "Topo (espera extra)", top);
      }
      const atCapture = await evaluate<SnapshotSummary>(cdp, 'window.__fp.snapshot("capture")');
      log.info("Estado no momento da captura", {
        elements: atCapture.total,
        translucent: atCapture.translucent,
        sample: atCapture.sample,
      });
      watch.lap("volta ao topo e animações");
    }
    log.info("Estratégia de captura", { modo: mode, motivos: decision.reasons, adaptativo: tuning.adaptive });

    // 4) Captura (integral ou por faixas) com verificação das dimensões reais.
    report("capturing", 70, "Capturando a imagem");
    await requireVisible(cdp, ctx, "antes do screenshot");
    const dpr = await evaluate<number>(cdp, "window.devicePixelRatio");
    const g = geometry(await measureContent(cdp), dpr);
    assertWithinSafetyCap(g);
    watch.lap("medidas");
    const shot = await captureImage(cdp, g, ctx);
    watch.lap("screenshot");
    log.info("PNG capturado", {
      width: shot.width,
      height: shot.height,
      estrategia: shot.strategy,
      faixas: shot.bands,
      dpr,
      escalaEfetiva: Math.round((shot.width / g.cssWidth) * 1000) / 1000,
      megapixels: Math.round((shot.width * shot.height) / 1e4) / 100,
      bytes: shot.blob.size,
    });
    report("capturing", 85, "Imagem capturada");
    return {
      blob: shot.blob,
      width: shot.width,
      height: shot.height,
      cssWidth: g.cssWidth,
      cssHeight: g.cssHeight,
      dpr,
      effectiveScale: g.effectiveScale,
      strategy: shot.strategy,
      bands: shot.bands,
      mode,
    };
  } catch (error) {
    log.error("Captura falhou", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    watch.skip();
    await restorePage(cdp, ctx, state);
    watch.lap("restauração");
    log.info("Tempos (ms)", { ...watch.snapshot(), modo: mode });
  }
}
