// Preparação da página antes da captura. Só usa CDP (sem chrome.*), então também roda em Node.
//
// Princípios (ver docs/decisoes/0003-captura-gsap.md):
// - Nada de opacity:1/transform:none globais e nada de emular prefers-reduced-motion: a página
//   decide o estado das animações no load, e reagir à mudança pode destruí-las de forma
//   irreversível (ex.: o stopAll() da LP Nexus).
// - Em vez disso, a página é percorrida de cima a baixo para que suas próprias animações/lazy load
//   rodem, os triggers de "replay" do ScrollTrigger são congelados, a captura é feita no topo e o
//   estado original é restaurado pelo mesmo caminho natural (descer e subir até a posição original).
import type { CapturePhase } from "../shared/messages.ts";
import type { Cdp } from "./cdp.ts";
import type { Logger } from "./log.ts";

const RESTORE_STEP_DELAY_MS = 150; // restauração: valores da v0.4.0 (não otimizada)
const MAX_SCROLL_MS = 60_000;
const MAX_STEPS = 400;
const FONTS_TIMEOUT_MS = 5_000;
const IMAGES_TIMEOUT_MS = 5_000;

// Parâmetros de tempo da preparação. BASELINE_V040 reproduz exatamente os valores da v0.4.0 (fallback
// seguro e referência das medições); cada campo pode ser ligado isoladamente nos testes (phase2-tests).
export interface Tuning {
  /** Passo da rolagem, em fração da altura da viewport. */
  scrollStride: number;
  /** Espera entre passos da rolagem. */
  stepDelayMs: number;
  /** Espera no fim da página para ver se ela parou de crescer. */
  bottomWaitMs: number;
  /** Janela de silêncio exigida para considerar as animações assentadas. */
  quietMs: number;
  /** Teto global do tempo gasto em esperas que estouraram o limite (animações que não assentam); null = sem teto. */
  wasteBudgetMs: number | null;
  /** Escolhe captura direta quando comprovadamente seguro (signals.ts); false = sempre a estratégia completa. */
  adaptive: boolean;
}

export const BASELINE_V040: Tuning = { scrollStride: 0.75, stepDelayMs: 150, bottomWaitMs: 400, quietMs: 400, wasteBudgetMs: null, adaptive: false };
export const DEFAULT_TUNING: Tuning = { scrollStride: 1.0, stepDelayMs: 50, bottomWaitMs: 250, quietMs: 250, wasteBudgetMs: 8_000, adaptive: true };

export interface ScrollPosition {
  x: number;
  y: number;
}

export type Report = (phase: Exclude<CapturePhase, "idle" | "saving" | "done" | "error">, progress: number, detail?: string) => void;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface EvaluateResponse {
  result: { value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

export async function evaluate<T>(cdp: Cdp, expression: string, awaitPromise = false): Promise<T> {
  const response = await cdp.send<EvaluateResponse>("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const { text, exception } = response.exceptionDetails;
    throw new Error(`Erro na página: ${exception?.description ?? text}`);
  }
  return response.result.value as T;
}

// Código injetado na página (mundo principal, para enxergar window.gsap). Ele só é instalado
// durante a captura e removido ao final (window.__fp).
const PROBE = `(() => {
  if (window.__fp) return true;
  const fp = { frozen: [], snaps: {} };
  // Diagnóstico: eventos de resize (a captura além da viewport pode redimensionar a janela virtual).
  fp.resize = { count: 0, minHeight: window.innerHeight, maxHeight: window.innerHeight, minWidth: window.innerWidth, maxWidth: window.innerWidth };
  fp.onResize = () => {
    fp.resize.count++;
    fp.resize.minHeight = Math.min(fp.resize.minHeight, window.innerHeight);
    fp.resize.maxHeight = Math.max(fp.resize.maxHeight, window.innerHeight);
    fp.resize.minWidth = Math.min(fp.resize.minWidth, window.innerWidth);
    fp.resize.maxWidth = Math.max(fp.resize.maxWidth, window.innerWidth);
  };
  window.addEventListener('resize', fp.onResize);
  // Sinal de reação: qualquer mutação do DOM (classe, estilo, nós, texto) enquanto a página é percorrida.
  fp.mut = 0;
  fp.mo = new MutationObserver((records) => { fp.mut += records.length; });
  fp.mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  fp.mutations = () => { fp.mut += fp.mo.takeRecords().length; return fp.mut; };
  fp.resetMutations = () => { fp.mo.takeRecords(); fp.mut = 0; };
  const root = () => document.scrollingElement || document.documentElement;

  fp.metrics = (y) => {
    window.scrollTo({ left: 0, top: y, behavior: 'instant' });
    return { viewportHeight: window.innerHeight, scrollHeight: root().scrollHeight, y: window.scrollY };
  };

  fp.info = () => ({
    gsap: (window.gsap && window.gsap.version) || null,
    scrollTrigger: window.ScrollTrigger ? ScrollTrigger.getAll().length : 0,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    scrollHeight: root().scrollHeight,
    dpr: window.devicePixelRatio,
    images: document.images.length,
    lazyImages: document.querySelectorAll('img[loading="lazy"]').length,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  });

  // Animações finitas em andamento. Repetições infinitas (loops decorativos) não contam.
  fp.busy = () => {
    let gsapCount = 0;
    const g = window.gsap;
    if (g && g.globalTimeline) {
      for (const c of g.globalTimeline.getChildren(true, true, true)) {
        if (c.paused() || !isFinite(c.totalDuration()) || c.totalProgress() >= 1) continue;
        if (c.isActive()) gsapCount++;
      }
    }
    const cssCount = document.getAnimations().filter((a) => {
      if (a.playState !== 'running') return false;
      const end = a.effect && a.effect.getComputedTiming().endTime;
      return typeof end === 'number' && isFinite(end);
    }).length;
    return { gsap: gsapCount, css: cssCount };
  };

  fp.settle = async (quietMs, maxMs) => {
    const t0 = performance.now();
    let quietSince = null;
    let last = { gsap: 0, css: 0 };
    for (;;) {
      last = fp.busy();
      const now = performance.now();
      if (last.gsap + last.css === 0) {
        if (quietSince === null) quietSince = now;
        if (now - quietSince >= quietMs) return { settled: true, ms: Math.round(now - t0), busy: last };
      } else quietSince = null;
      if (now - t0 > maxMs) return { settled: false, ms: Math.round(now - t0), busy: last };
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  // Triggers de "replay" (play/reset ao entrar/sair) escondem o conteúdo de novo ao voltar ao topo.
  // Congela só esses, preservando o estado atual: scrub e pin continuam acompanhando a rolagem.
  fp.freeze = () => {
    const ST = window.ScrollTrigger;
    if (!ST) return { frozen: 0, kept: 0 };
    let kept = 0;
    for (const st of ST.getAll()) {
      if (!st.enabled || st.vars.scrub || st.pin) { kept++; continue; }
      st.disable(false, true); // sem reverter, sem pausar a animação
      fp.frozen.push(st);
    }
    return { frozen: fp.frozen.length, kept };
  };

  fp.unfreeze = () => {
    const n = fp.frozen.length;
    for (const st of fp.frozen) st.enable(false, false); // sem reset de progresso, sem refresh
    fp.frozen = [];
    return n;
  };

  // Mapa índice-no-DOM -> "opacidade efetiva|transform" para comparar antes/depois.
  fp.snapshot = (name) => {
    const cache = new Map();
    const eff = (el) => {
      if (!el || el.nodeType !== 1) return 1;
      if (cache.has(el)) return cache.get(el);
      const v = parseFloat(getComputedStyle(el).opacity) * eff(el.parentElement);
      cache.set(el, v);
      return v;
    };
    const map = {};
    const translucent = [];
    let i = -1;
    for (const el of document.body.querySelectorAll('*')) {
      i++;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const op = Math.round(eff(el) * 100) / 100;
      const tf = cs.transform === 'none' ? '' : cs.transform.replace(/-?\\d+\\.\\d+/g, (m) => (+m).toFixed(1));
      map[i] = op + '|' + tf;
      if (op < 0.98 && r.width >= 40 && r.height >= 20 && translucent.length < 200) {
        translucent.push({ i, tag: el.tagName.toLowerCase(), cls: String(el.getAttribute('class') || '').slice(0, 40), top: Math.round(r.top + window.scrollY), op });
      }
    }
    fp.snaps[name] = map;
    return { total: Object.keys(map).length, translucent: translucent.length, sample: translucent.slice(0, 6) };
  };

  fp.diff = (a, b) => {
    const A = fp.snaps[a] || {}, B = fp.snaps[b] || {};
    const changed = [];
    const opacity = (v) => v.split('|')[0];
    for (const k of Object.keys(A)) {
      if (B[k] === undefined || B[k] === A[k]) continue;
      // totalmente transparente nos dois estados: o transform não é visível
      if (opacity(A[k]) === '0' && opacity(B[k]) === '0') continue;
      changed.push({ i: +k, from: A[k], to: B[k] });
    }
    return { changed: changed.length, sample: changed.slice(0, 6) };
  };

  // Sinais observáveis (independentes de biblioteca) usados por signals.ts para escolher a estratégia.
  fp.signals = () => {
    let finite = 0, infinite = 0, scrollLinked = 0;
    for (const a of document.getAnimations()) {
      if (typeof ScrollTimeline !== 'undefined' && a.timeline instanceof ScrollTimeline) { scrollLinked++; continue; }
      if (a.playState !== 'running') continue;
      const end = a.effect && a.effect.getComputedTiming().endTime;
      if (typeof end === 'number' && isFinite(end)) finite++; else infinite++;
    }
    const imgs = Array.from(document.images);
    return {
      finite, infinite, scrollLinked,
      images: imgs.length,
      imagesComplete: imgs.filter((i) => i.complete).length,
      lazyPending: imgs.filter((i) => i.loading === 'lazy' && !i.complete).length,
      iframes: document.querySelectorAll('iframe').length,
      scrollHeight: root().scrollHeight,
      scrollTrigger: window.ScrollTrigger ? ScrollTrigger.getAll().length : 0,
      gsap: !!window.gsap,
      gsapActive: fp.busy().gsap,
      fontsLoading: document.fonts.status === 'loading',
      mutations: fp.mutations(),
    };
  };

  fp.cleanup = () => {
    try { fp.mo.disconnect(); } catch (e) {}
    try { if (fp.frozen.length) fp.unfreeze(); } catch (e) {}
    window.removeEventListener('resize', fp.onResize);
    delete window.__fp;
  };

  window.__fp = fp;
  return true;
})()`;

export async function installProbe(cdp: Cdp): Promise<void> {
  await evaluate(cdp, PROBE);
}

export async function removeProbe(cdp: Cdp): Promise<void> {
  await evaluate(cdp, "window.__fp && window.__fp.cleanup()");
}

export interface PageInfo {
  gsap: string | null;
  scrollTrigger: number;
  viewport: string;
  scrollHeight: number;
  dpr: number;
  images: number;
  lazyImages: number;
  reducedMotion: boolean;
}

export const pageInfo = (cdp: Cdp) => evaluate<PageInfo>(cdp, "window.__fp.info()");

export async function readScroll(cdp: Cdp): Promise<ScrollPosition> {
  return evaluate<ScrollPosition>(cdp, "({ x: window.scrollX, y: window.scrollY })");
}

export async function scrollTo(cdp: Cdp, position: ScrollPosition): Promise<void> {
  // behavior "instant" ignora `scroll-behavior: smooth` do CSS da página.
  await evaluate(cdp, `window.scrollTo({ left: ${position.x}, top: ${position.y}, behavior: "instant" })`);
}

export async function waitForFonts(cdp: Cdp): Promise<void> {
  await evaluate(
    cdp,
    `Promise.race([
      document.fonts.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), ${FONTS_TIMEOUT_MS})),
    ])`,
    true,
  );
}

async function waitForImages(cdp: Cdp): Promise<number> {
  return evaluate<number>(
    cdp,
    `(async () => {
      const pending = Array.from(document.images).filter((img) => !img.complete);
      await Promise.race([
        Promise.all(pending.map((img) => new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        }))),
        new Promise((resolve) => setTimeout(resolve, ${IMAGES_TIMEOUT_MS})),
      ]);
      return pending.length;
    })()`,
    true,
  );
}

export interface SettleResult {
  settled: boolean;
  ms: number;
  busy: { gsap: number; css: number };
}

export function settle(cdp: Cdp, quietMs = 400, maxMs = 8_000): Promise<SettleResult> {
  return evaluate<SettleResult>(cdp, `window.__fp.settle(${quietMs}, ${maxMs})`, true);
}

interface ScrollMetrics {
  viewportHeight: number;
  scrollHeight: number;
  y: number;
}

const metricsAt = (cdp: Cdp, y: number) => evaluate<ScrollMetrics>(cdp, `window.__fp.metrics(${y})`);

export interface ScrollSummary {
  steps: number;
  scrollHeight: number;
  truncated: boolean;
  pendingImages: number;
}

// Rola de cima para baixo em passos curtos (cada passo é um comando CDP, o que também mantém o
// service worker ativo), reavaliando a altura a cada passo para cobrir lazy loading e páginas
// que crescem. Termina no fim da página.
export async function scrollDown(
  cdp: Cdp,
  onPercent: (percent: number) => void,
  tuning: Tuning = BASELINE_V040,
): Promise<ScrollSummary> {
  const deadline = Date.now() + MAX_SCROLL_MS;
  let y = 0;
  let steps = 0;
  let scrollHeight = 0;
  let truncated = false;

  for (;;) {
    if (steps >= MAX_STEPS || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const metrics = await metricsAt(cdp, y);
    scrollHeight = metrics.scrollHeight;
    steps += 1;
    onPercent(Math.min(100, Math.round(((y + metrics.viewportHeight) / scrollHeight) * 100)));
    await sleep(tuning.stepDelayMs);

    if (y + metrics.viewportHeight >= scrollHeight - 1) {
      await sleep(tuning.bottomWaitMs);
      const after = await metricsAt(cdp, y);
      if (after.scrollHeight <= scrollHeight) break; // a página parou de crescer
      scrollHeight = after.scrollHeight;
    }
    y += Math.max(200, Math.floor(metrics.viewportHeight * tuning.scrollStride));
  }

  const pendingImages = await waitForImages(cdp);
  return { steps, scrollHeight, truncated, pendingImages };
}

// Caminho inverso: do fim da página até a posição original, em passos, para que a lógica da
// própria página (ex.: onLeaveBack) reajuste o que estiver acima/abaixo do ponto original.
export async function scrollUpTo(cdp: Cdp, target: ScrollPosition): Promise<void> {
  const bottom = await metricsAt(cdp, Number.MAX_SAFE_INTEGER);
  const stride = Math.max(200, Math.floor(bottom.viewportHeight * 0.75));
  await sleep(RESTORE_STEP_DELAY_MS);
  for (let y = bottom.y - stride; y > target.y; y -= stride) {
    await metricsAt(cdp, y);
    await sleep(RESTORE_STEP_DELAY_MS);
  }
  await scrollTo(cdp, target);
}

export const goToBottom = (cdp: Cdp) => metricsAt(cdp, Number.MAX_SAFE_INTEGER);

export function logSettle(log: Logger, label: string, result: SettleResult): void {
  const data = { settled: result.settled, ms: result.ms, busy: result.busy };
  if (result.settled) log.info(`${label}: animações concluídas`, data);
  else log.warn(`${label}: animações ainda em andamento no limite de espera`, data);
}

export const visibilityState = (cdp: Cdp) => evaluate<string>(cdp, "document.visibilityState");
