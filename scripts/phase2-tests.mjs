// Testes e medições da v0.5.0 (Fases 2 e 3): otimizações de tempo e Capture Strategy Engine.
// Chrome headless + fixtures locais, usando os mesmos módulos da extensão em Node. NÃO testa a extensão instalada
// (ver docs/auditoria/06-checklist-v050.md).
//
// Uso: node scripts/phase2-tests.mjs <pasta-saida> [--only=u,m,r] [--reps=2] [--variants=v040,all] [--fixtures=static,gsap-st] [--real]
//   u = decide() (unitário)   m = matriz fixtures × variantes (tempo + fidelidade + pixel-diff)   r = resiliência (erro, 2x, faixas, aba oculta)
// Variantes (cada otimização ISOLADA sobre a v0.4.0, depois todas juntas):
//   v040 = parâmetros da v0.4.0 | stride = passo 1,0 viewport + 50 ms | quiet = silêncio 250 ms + fundo 250 ms
//   budget = teto global de esperas desperdiçadas | adaptive = captura direta quando seguro (tempos da v0.4.0) | all = padrão da v0.5.0
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_V040, DEFAULT_TUNING, capturePage } from "../src/background/capture.ts";
import { decide } from "../src/background/signals.ts";
import { expected, startFixtureServer } from "./fixtures.mjs";
import { evalIn, launch, navigate, newPage, setDisplay, sleep } from "./lib/browser.mjs";
import { nodeDecodeStrip } from "./lib/node-decode.mjs";
import { decodePng, scoreBlocks } from "./lib/png.mjs";

const [outDir, ...flags] = process.argv.slice(2);
if (!outDir) { console.error("Uso: node scripts/phase2-tests.mjs <pasta-saida> [--only=u,m,r] [--reps=N] [--variants=…] [--fixtures=…] [--real]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = flag("only")?.split(",");
const want = (id) => !only || only.includes(id);
const reps = Number(flag("reps") ?? 2);

const VARIANTS = {
  v040: BASELINE_V040,
  stride: { ...BASELINE_V040, scrollStride: DEFAULT_TUNING.scrollStride, stepDelayMs: DEFAULT_TUNING.stepDelayMs },
  quiet: { ...BASELINE_V040, quietMs: DEFAULT_TUNING.quietMs, bottomWaitMs: DEFAULT_TUNING.bottomWaitMs },
  budget: { ...BASELINE_V040, wasteBudgetMs: DEFAULT_TUNING.wasteBudgetMs },
  adaptive: { ...BASELINE_V040, adaptive: true },
  all: DEFAULT_TUNING,
};
const variantNames = (flag("variants") ?? Object.keys(VARIANTS).join(",")).split(",");
const FIXTURES = [
  "static", "lazy-long", "gsap-st", "io-css", "spa-vue", "sticky-fixed", "vh", "iframes",
  "css-anim", "waapi-reveal", "aos-like", "aos-like?mode=toggle", "late-lazy", "dynamic", "header-scroll", "scroll-js", "very-long?h=9000",
];
const fixtureNames = flag("fixtures")?.split(",") ?? FIXTURES;

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "OK   " : "FALHA"} ${name}${detail ? " — " + detail : ""}`); };

// ---------------------------------------------------------------- U: decide() (unitário, sem navegador)
if (want("u")) {
  console.log("\n== U: decide() — cada sinal de risco força a estratégia completa; sinais ausentes = completa");
  const quiet = { finite: 0, infinite: 0, scrollLinked: 0, images: 3, imagesComplete: 3, lazyPending: 0, iframes: 0, scrollHeight: 6000, scrollTrigger: 0, gsap: false, gsapActive: 0, fontsLoading: false, mutations: 0 };
  const base = { initial: quiet, initialSettled: true, baselineMutations: 0, afterScroll: quiet, scrollTruncated: false };
  check("U1 página sem reação => direta", decide(base).mode === "direct");
  check("U2 animação infinita decorativa => direta", decide({ ...base, afterScroll: { ...quiet, infinite: 2 } }).mode === "direct");
  const cases = {
    "mutações durante a rolagem": { afterScroll: { ...quiet, mutations: 3 } },
    "ruído de base (mutações em repouso)": { baselineMutations: 2 },
    "não assentou antes de rolar": { initialSettled: false },
    "rolagem truncada": { scrollTruncated: true },
    "ScrollTrigger": { afterScroll: { ...quiet, scrollTrigger: 2 } },
    "GSAP ativo": { afterScroll: { ...quiet, gsapActive: 1 } },
    "scroll-driven": { afterScroll: { ...quiet, scrollLinked: 1 } },
    "iframe": { afterScroll: { ...quiet, iframes: 1 } },
    "imagem lazy pendente antes": { initial: { ...quiet, lazyPending: 2 } },
    "imagem pendente depois": { afterScroll: { ...quiet, imagesComplete: 2 } },
    "imagem carregada pela rolagem": { initial: { ...quiet, images: 5, imagesComplete: 2 }, afterScroll: { ...quiet, images: 5, imagesComplete: 5 } },
    "altura mudou": { afterScroll: { ...quiet, scrollHeight: 6400 } },
    "animação finita disparada": { afterScroll: { ...quiet, finite: 1 } },
    "fontes carregando": { afterScroll: { ...quiet, fontsLoading: true } },
  };
  for (const [label, patch] of Object.entries(cases)) {
    const d = decide({ ...base, ...patch });
    check(`U ${label} => completa`, d.mode === "full" && d.reasons.length > 0, d.reasons[0]);
  }
  check("U sem sinais iniciais => completa", decide({ ...base, initial: undefined }).mode === "full");
  check("U entrada nula => completa", decide(null).mode === "full");
  check("U altura com arredondamento (≤2 px) => direta", decide({ ...base, afterScroll: { ...quiet, scrollHeight: 6001 } }).mode === "direct");
}

// ---------------------------------------------------------------- navegador
const needsBrowser = want("m") || want("r");
let server, port, browser;
if (needsBrowser) {
  ({ server, port } = await startFixtureServer(0));
  browser = await launch({ width: 1280, height: 800 });
}

const collector = () => { const entries = []; const push = (level) => (message, data) => entries.push({ level, message, data }); return { entries, log: { info: push("info"), warn: push("warn"), error: push("error") } }; };
const find = (entries, prefix) => entries.find((e) => e.message.startsWith(prefix));

async function run(target, tuning, { dpr = 1, width = 1280, height = 800, settleMs = 1800, base = `http://127.0.0.1:${port}`, ctx = {}, hidden = false } = {}) {
  const page = await newPage(browser);
  await setDisplay(page.cdp, { width, height, dpr });
  await navigate(page.cdp, target.startsWith("http") ? target : `${base}/p/${target}`, { settleMs });
  const before = await evalIn(page.cdp, "({ y: scrollY, vh: innerHeight })", false);
  const { entries, log } = collector();
  let image, error;
  const t0 = Date.now();
  try { image = await capturePage(page.cdp, { log, report: () => {}, decodeStrip: nodeDecodeStrip, tuning, ...ctx }); } catch (e) { error = e; }
  const ms = Date.now() - t0;
  const after = await evalIn(page.cdp, "({ y: scrollY, probe: typeof window.__fp })", false);
  const restore = find(entries, "Estado restaurado");
  await page.close();
  return { image, error, entries, ms, before, scrollOk: after.y === before.y, probeGone: after.probe === "undefined", restoreIdentical: restore ? restore.level === "info" : null };
}
const nameOf = (t) => t.split("?")[0];
const queryOf = (t) => new URLSearchParams(t.split("?")[1] ?? "");
async function score(r, target) {
  const png = decodePng(Buffer.from(await r.image.blob.arrayBuffer()));
  const s = scoreBlocks(png, expected(nameOf(target), queryOf(target), { vh: r.before.vh, port }), png.width / r.image.cssWidth);
  return { png, ...s };
}
const diffPixels = (a, b) => {
  if (a.width !== b.width || a.height !== b.height) return { comparable: false };
  let diff = 0;
  const n = a.width * a.height;
  for (let p = 0; p < n; p++) {
    const i = p * a.channels, j = p * b.channels;
    if (a.data[i] !== b.data[j] || a.data[i + 1] !== b.data[j + 1] || a.data[i + 2] !== b.data[j + 2]) diff++;
  }
  return { comparable: true, diff, of: n };
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---------------------------------------------------------------- M: matriz fixtures × variantes
if (want("m")) {
  console.log(`\n== M: matriz (fixtures × variantes), ${reps} repetição(ões); tempos em segundos (mediana); fidelidade = blocos corretos`);
  const table = [];
  for (const target of fixtureNames) {
    const row = { fixture: target, variants: {} };
    let refPng = null;
    for (const v of variantNames) {
      const runs = [];
      for (let k = 0; k < reps; k++) {
        const r = await run(target, VARIANTS[v]);
        if (!r.image) { runs.push({ error: r.error?.message, ms: r.ms }); continue; }
        const s = await score(r, target);
        const modeLog = find(r.entries, "Estratégia de captura")?.data;
        const wasteful = r.entries.filter((e) => e.message.includes("animações ainda em andamento")).length;
        const entry = { ms: r.ms, ok: s.ok, total: s.total, failed: s.failed, size: `${r.image.width}x${r.image.height}`, mode: r.image.mode, reasons: modeLog?.motivos, restored: r.scrollOk && r.probeGone, restoreIdentical: r.restoreIdentical, unsettled: wasteful, tempos: find(r.entries, "Tempos")?.data };
        if (k === 0 && v === "v040") refPng = s.png;
        else if (k === 0 && refPng && target !== "very-long?h=9000") entry.pixelDiffVsV040 = diffPixels(refPng, s.png);
        runs.push(entry);
      }
      row.variants[v] = { runs, medianMs: median(runs.filter((x) => x.ms).map((x) => x.ms)) };
      const first = runs[0];
      console.log(`${target.padEnd(22)} ${v.padEnd(9)} ${first.error ? "ERRO " + first.error : `${first.ok}/${first.total} ${first.mode.padEnd(6)} ${(row.variants[v].medianMs / 1000).toFixed(1)} s  ${first.restored ? "" : "SEM-RESTAURAR "}${first.pixelDiffVsV040 ? `Δpx=${first.pixelDiffVsV040.comparable ? first.pixelDiffVsV040.diff : "dim"}` : ""}${first.reasons ? "  [" + first.reasons[0].slice(0, 70) + "]" : ""}`}`);
    }
    table.push(row);
  }
  writeFileSync(join(outDir, "matriz-v050.json"), JSON.stringify(table, null, 1));

  // verificações de aceite derivadas da matriz
  const get = (f, v) => table.find((r) => r.fixture === f)?.variants[v];
  for (const row of table) {
    const base = row.variants.v040, all = row.variants.all;
    if (!base || !all || base.runs[0].error || all.runs[0].error) continue;
    check(`M ${row.fixture}: fidelidade v0.5.0 ≥ v0.4.0`, all.runs.every((x) => x.ok >= base.runs[0].ok), `${base.runs[0].ok}/${base.runs[0].total} → ${all.runs.map((x) => x.ok).join(",")}/${base.runs[0].total}`);
    check(`M ${row.fixture}: página restaurada (rolagem + sonda removida)`, all.runs.every((x) => x.restored));
  }
  for (const f of ["static", "css-anim"]) {
    const a = get(f, "all");
    if (a) check(`M ${f}: captura DIRETA`, a.runs.every((x) => x.mode === "direct"), a.runs.map((x) => x.mode).join(","));
  }
  for (const f of ["gsap-st", "io-css", "aos-like", "aos-like?mode=toggle", "waapi-reveal", "late-lazy", "scroll-js", "lazy-long", "spa-vue", "dynamic"]) {
    const a = get(f, "all");
    if (a) check(`M ${f}: NÃO usa captura direta`, a.runs.every((x) => x.mode === "full"), a.runs.map((x) => x.mode).join(","));
  }
}

// ---------------------------------------------------------------- R: resiliência
if (want("r")) {
  console.log("\n== R: resiliência (2x, faixas, verificação reprovada, aba oculta, erro)");
  // R1 2x e faixas continuam funcionando no caminho direto e no completo
  for (const [label, tuning] of [["direta/padrão", DEFAULT_TUNING], ["v0.4.0", BASELINE_V040]]) {
    const r = await run("static", tuning, { dpr: 1 });
    check(`R1 2x garantido (${label})`, r.image && r.image.effectiveScale === 2 && r.image.width === Math.round(r.image.cssWidth * 2), r.image ? `${r.image.width}x${r.image.height} modo=${r.image.mode}` : r.error?.message);
  }
  const big = await run("very-long?h=30000", DEFAULT_TUNING, { dpr: 1, width: 625 });
  check("R2 página de 30 000 px CSS: faixas + 2x no padrão v0.5.0", big.image && big.image.strategy === "bands" && big.image.effectiveScale === 2 && big.restoreIdentical !== false && big.scrollOk, big.image ? `${big.image.width}x${big.image.height} ${big.image.strategy}(${big.image.bands}) modo=${big.image.mode}` : big.error?.message);
  const hi = await run("static", DEFAULT_TUNING, { dpr: 3 });
  check("R3 DPR 3 preservado (3x)", hi.image && hi.image.effectiveScale === 3, hi.image ? `${hi.image.width}x${hi.image.height}` : hi.error?.message);

  // R4 aba que muda DURANTE a captura direta: precisa recorrer à completa (ou capturar certo) — simulado com IO tardio
  const late = await run("late-lazy", DEFAULT_TUNING);
  const sl = late.image && (await score(late, "late-lazy"));
  check("R4 conteúdo com sentinela a 60% (cobertura da sonda)", late.image && sl.ok === sl.total && late.image.mode === "full", late.image ? `${sl.ok}/${sl.total} modo=${late.image.mode}` : late.error?.message);

  // R5 falha no meio da captura: restauração
  const failing = await run("static", DEFAULT_TUNING, { ctx: { decodeStrip: undefined } });
  check("R5 captura normal restaura a página", failing.scrollOk && failing.probeGone);
  const page = await newPage(browser);
  await setDisplay(page.cdp, { width: 1280, height: 800, dpr: 1 });
  await navigate(page.cdp, `http://127.0.0.1:${port}/p/gsap-st`, { settleMs: 1800 });
  await evalIn(page.cdp, "window.scrollTo({top:900,behavior:'instant'})", false);
  await sleep(1200);
  const y0 = await evalIn(page.cdp, "scrollY", false);
  const { log } = collector();
  let calls = 0;
  const flaky = { ...page.cdp, send: (m, p) => { if (m === "Page.captureScreenshot" && ++calls >= 1) return Promise.reject(new Error("falha simulada")); return page.cdp.send(m, p); } };
  let threw;
  try { await capturePage(flaky, { log, report: () => {}, decodeStrip: nodeDecodeStrip, tuning: DEFAULT_TUNING }); } catch (e) { threw = e; }
  await sleep(300);
  const post = await evalIn(page.cdp, "({ y: scrollY, probe: typeof window.__fp })", false);
  check("R6 erro durante o screenshot: página restaurada (rolagem original, sonda removida)", threw && post.y === y0 && post.probe === "undefined", `y ${y0} → ${post.y}`);
  await page.close();

  // R7 aba oculta no caminho adaptativo
  const hid = await run("static", DEFAULT_TUNING, {});
  check("R7 captura padrão em aba visível não aciona ensureVisible", hid.image && !find(hid.entries, "Aba em segundo plano"));
}

if (browser) { browser.kill(); server.close(); }
const failed = results.filter((r) => !r.ok);
writeFileSync(join(outDir, "resultado-phase2.json"), JSON.stringify(results, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} verificações OK${failed.length ? " — FALHAS: " + failed.map((f) => f.name).join("; ") : ""}`);
setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
