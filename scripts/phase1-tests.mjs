// Testes automatizados da Fase 1 (Chrome headless + fixtures locais + stub de chrome.* para o FocusGuard).
// NÃO testa a extensão instalada (chrome.debugger real, chrome.tabs/windows reais, popup, prévia): ver
// docs/auditoria/05-checklist-fase1.md.
//
// Uso: node scripts/phase1-tests.mjs <pasta-saida> [--only=t1,t4,...]
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capturePage, limits } from "../src/background/capture.ts";
import { FocusGuard } from "../src/background/focus.ts";
import { expected, startFixtureServer } from "./fixtures.mjs";
import { connect, evalIn, launch, navigate, newPage, setDisplay, sleep } from "./lib/browser.mjs";
import { nodeDecodeStrip } from "./lib/node-decode.mjs";
import { decodePng, scoreBlocks } from "./lib/png.mjs";

const [outDir, ...flags] = process.argv.slice(2);
if (!outDir) { console.error("Uso: node scripts/phase1-tests.mjs <pasta-saida> [--only=t1,t2]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const only = flags.find((f) => f.startsWith("--only="))?.slice(7).split(",");
const want = (id) => !only || only.includes(id);

const { server, port } = await startFixtureServer(0);
const browser = await launch({ width: 1280, height: 800 });
const bws = connect((await browser.json("/json/version")).webSocketDebuggerUrl);
await bws.opened;

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "OK   " : "FALHA"} ${name}${detail ? " — " + detail : ""}`); };
const collector = () => { const entries = []; const push = (level) => (message, data) => entries.push({ level, message, data }); return { entries, log: { info: push("info"), warn: push("warn"), error: push("error") } }; };
const find = (entries, prefix) => entries.find((e) => e.message.startsWith(prefix));
const bytesOf = async (image) => Buffer.from(await image.blob.arrayBuffer());
const diffPixels = (a, b) => {
  if (a.width !== b.width || a.height !== b.height) return { comparable: false, a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` };
  // compara por pixel (R, G, B e, se ambos tiverem, alfa): os canais podem diferir (RGB do Chrome × RGBA da costura)
  let diff = 0;
  const pixels = a.width * a.height;
  for (let p = 0; p < pixels; p++) {
    const i = p * a.channels, j = p * b.channels;
    if (a.data[i] !== b.data[j] || a.data[i + 1] !== b.data[j + 1] || a.data[i + 2] !== b.data[j + 2]) { diff++; continue; }
    if (a.channels === 4 && b.channels === 4 && a.data[i + 3] !== b.data[j + 3]) diff++;
  }
  return { comparable: true, diff, ofPixels: pixels };
};

async function capture(path, { dpr = 1, width = 1280, height = 800, wrap, ctx = {}, startY = 0, settleMs = 1800, keepPage = false, during } = {}) {
  const page = await newPage(browser);
  await setDisplay(page.cdp, { width, height, dpr });
  await navigate(page.cdp, `http://127.0.0.1:${port}${path}`, { settleMs });
  if (startY) { await evalIn(page.cdp, `window.scrollTo({top:${startY},behavior:'instant'})`, false); await sleep(1500); }
  const before = await evalIn(page.cdp, "({ y: scrollY, vh: innerHeight })", false);
  const { entries, log } = collector();
  const cdp = wrap ? wrap(page.cdp) : page.cdp;
  let image, error;
  const t0 = Date.now();
  const run = capturePage(cdp, { log, report: () => {}, decodeStrip: nodeDecodeStrip, ...ctx }).then((i) => (image = i), (e) => (error = e));
  if (during) await during(page);
  await run;
  const ms = Date.now() - t0;
  const after = await evalIn(page.cdp, "({ y: scrollY, probe: typeof window.__fp })", false);
  const restore = find(entries, "Estado restaurado");
  const out = { page, image, error, entries, ms, before, scrollOk: after.y === before.y, probeGone: after.probe === "undefined", restoreIdentical: restore ? restore.level === "info" : null };
  if (!keepPage) await page.close();
  return out;
}
const scoreOf = async (r, name, query = new URLSearchParams()) => {
  const png = decodePng(await bytesOf(r.image));
  const s = scoreBlocks(png, expected(name, query, { vh: r.before.vh, port }), png.width / r.image.cssWidth);
  return { png, ...s };
};
const restored = (r) => r.scrollOk && r.probeGone;

// ------------------------------------------------------------------ T1: política de escala
if (want("t1")) {
  console.log("\n== T1: política de escala (mínimo 2x; DPR maior preservado)");
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const r = await capture("/p/static", { dpr });
    const want2 = Math.max(2, dpr);
    const dims = r.image && { w: r.image.width, h: r.image.height, ew: Math.round(r.image.cssWidth * want2), eh: Math.round(r.image.cssHeight * want2) };
    const okDims = dims && Math.abs(dims.w - dims.ew) <= 1 && Math.abs(dims.h - dims.eh) <= 1;
    check(`DPR ${dpr} → escala efetiva ${want2}x`, r.image && r.image.effectiveScale === want2 && okDims && r.image.strategy === "single" && restored(r),
      r.image ? `PNG ${r.image.width}x${r.image.height} para ${r.image.cssWidth}x${r.image.cssHeight} CSS, ${r.ms} ms` : String(r.error?.message));
  }
}

// ------------------------------------------------------------------ T2: equivalência de pixels entre monitores
if (want("t2")) {
  console.log("\n== T2: monitor 1x (clip.scale 2) × monitor 2x (clip.scale 1) → pixels idênticos");
  const a = await capture("/p/static", { dpr: 1 });
  const b = await capture("/p/static", { dpr: 2 });
  const d = diffPixels(decodePng(await bytesOf(a.image)), decodePng(await bytesOf(b.image)));
  check("PNG do monitor 1x idêntico ao do 2x", d.comparable && d.diff === 0, JSON.stringify(d));
}

// ------------------------------------------------------------------ T3: fidelidade e restauração (fixtures)
if (want("t3")) {
  console.log("\n== T3: fidelidade por pixel e restauração (DPR 1 → 2x)");
  const cases = [["static", 6], ["gsap-st", 8], ["spa-vue", 10], ["sticky-fixed", 8], ["vh", 6], ["lazy-long", 24], ["iframes", 3], ["io-css", 8]];
  for (const [name, minOk] of cases) {
    const r = await capture(`/p/${name}`, { dpr: 1 });
    if (!r.image) { check(`fixture ${name}`, false, r.error?.message); continue; }
    const s = await scoreOf(r, name);
    check(`fixture ${name}: ≥${minOk} blocos corretos a ${r.image.effectiveScale}x`, s.ok >= minOk && restored(r),
      `${s.ok}/${s.total}; ${r.image.width}x${r.image.height}; ${(r.ms / 1000).toFixed(1)} s; restauração ${r.restoreIdentical === null ? "-" : r.restoreIdentical ? "idêntica" : "difere"}`);
  }
  // as páginas antes recusadas pela trava de 16384 px (14400 px CSS a 2x = 28 800 px) agora precisam passar
  const lazy = await capture("/p/lazy-long", { dpr: 2 });
  const sl = lazy.image && (await scoreOf(lazy, "lazy-long"));
  check("lazy-long a DPR 2 (antes recusada)", lazy.image && sl.ok === 24, lazy.image ? `${lazy.image.width}x${lazy.image.height} ${lazy.image.strategy}(${lazy.image.bands})` : lazy.error?.message);
}

// ------------------------------------------------------------------ T4: faixas sem perda
if (want("t4")) {
  console.log("\n== T4: captura por faixas (páginas acima dos limiares)");
  // 30 000 px CSS × 625 → 1250×60000 a 2x (lado > 16384 → faixas)
  const r = await capture("/p/very-long?h=30000", { dpr: 1, width: 640, settleMs: 600, keepPage: true });
  if (!r.image) check("faixas: 30000 px CSS a 2x", false, r.error?.message);
  else {
    const q = new URLSearchParams({ h: 30000 });
    const s = await scoreOf(r, "very-long", q);
    const ref = await r.page.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: r.image.cssWidth, height: r.image.cssHeight, scale: 2 } });
    const d = diffPixels(s.png, decodePng(Buffer.from(ref.data, "base64")));
    check("faixas: estratégia 'bands' e dimensões exatas", r.image.strategy === "bands" && r.image.bands > 1 && r.image.width === r.image.cssWidth * 2 && r.image.height === r.image.cssHeight * 2, `${r.image.width}x${r.image.height} em ${r.image.bands} faixas, ${(r.ms / 1000).toFixed(1)} s`);
    check("faixas: todos os blocos corretos", s.ok === s.total, `${s.ok}/${s.total}`);
    check("faixas: pixel-idêntico à captura integral de referência", d.comparable && d.diff === 0, JSON.stringify(d));
    check("faixas: restauração (scroll, probe)", restored(r));
    await r.page.close();
  }
  // páginas reais que a trava recusava: 9000 px CSS × 1265 a 2x = 18 000 px
  const r2 = await capture("/p/very-long?h=9000", { dpr: 1, settleMs: 600 });
  const s2 = r2.image && (await scoreOf(r2, "very-long", new URLSearchParams({ h: 9000 })));
  check("9000 px CSS a 2x (antes recusada)", r2.image && s2.ok === s2.total, r2.image ? `${r2.image.width}x${r2.image.height} ${r2.image.strategy}(${r2.image.bands}) ${s2.ok}/${s2.total}` : r2.error?.message);
  const r3 = await capture("/p/very-long?h=20000", { dpr: 1, settleMs: 600 });
  const s3 = r3.image && (await scoreOf(r3, "very-long", new URLSearchParams({ h: 20000 })));
  check("20000 px CSS a 2x (antes recusada)", r3.image && s3.ok === s3.total, r3.image ? `${r3.image.width}x${r3.image.height} ${r3.image.strategy}(${r3.image.bands}) ${s3.ok}/${s3.total}; ${(r3.ms / 1000).toFixed(1)} s` : r3.error?.message);
}

// ------------------------------------------------------------------ T5: fallback quando a captura integral falha
if (want("t5")) {
  console.log("\n== T5: captura integral falha → faixas (resolução preservada)");
  const wrap = (cdp) => ({ send: (m, p) => (m === "Page.captureScreenshot" && p?.clip?.height > 5000 ? Promise.reject(new Error("simulado: textura excede o limite")) : cdp.send(m, p)) });
  const r = await capture("/p/very-long?h=8000", { dpr: 1, width: 640, settleMs: 600, wrap });
  const s = r.image && (await scoreOf(r, "very-long", new URLSearchParams({ h: 8000 })));
  check("fallback para faixas após erro simulado", r.image && r.image.strategy === "bands" && s.ok === s.total && r.image.effectiveScale === 2, r.image ? `${r.image.width}x${r.image.height} ${r.image.bands} faixas ${s.ok}/${s.total}` : r.error?.message);
  check("fallback: log registra o aviso", !!find(r.entries, "Captura integral falhou"));
  check("fallback: restauração", restored(r));
}

// ------------------------------------------------------------------ T6: dimensões erradas → erro claro, nunca redução silenciosa
if (want("t6")) {
  console.log("\n== T6: tentativa de reduzir a escala em silêncio → erro claro");
  const wrap = (cdp) => ({ send: (m, p) => (m === "Page.captureScreenshot" ? cdp.send(m, { ...p, clip: { ...p.clip, scale: 1 } }) : cdp.send(m, p)) });
  const r = await capture("/p/static", { dpr: 1, wrap });
  check("sem imagem quando só dá 1x", !r.image && !!r.error, r.error ? "erro: " + r.error.message.slice(0, 170) : "capturou!");
  check("mensagem cita a resolução mínima, as dimensões obtidas e as esperadas", /resolução mínima de 2x/.test(r.error?.message ?? "") && /esperado era/.test(r.error?.message ?? ""));
  check("restauração mesmo com erro", restored(r));
}

// ------------------------------------------------------------------ T7: teto de segurança antes de preparar
if (want("t7")) {
  console.log("\n== T7: teto de segurança (erro claro e ANTES da preparação)");
  const old = limits.absoluteMaxPixels;
  limits.absoluteMaxPixels = 1_000_000;
  const r = await capture("/p/static", { dpr: 1 });
  limits.absoluteMaxPixels = old;
  check("recusa com mensagem clara", !r.image && /teto de segurança/.test(r.error?.message ?? "") && /resolução mínima de 2x não pode ser reduzida/.test(r.error?.message ?? ""), r.error?.message.slice(0, 120));
  check("recusa antes de rolar (sem fase de rolagem)", !find(r.entries, "Rolagem concluída"), `${r.ms} ms`);
  check("restauração", restored(r));
}

// ------------------------------------------------------------------ T8: aba em segundo plano
if (want("t8")) {
  console.log("\n== T8: aba em segundo plano");
  const hide = async (page) => { const other = await bws.send("Target.createTarget", { url: "about:blank" }); await bws.send("Target.activateTarget", { targetId: other.targetId }); await sleep(700); return other; };
  const closeOther = (other) => bws.send("Target.closeTarget", { targetId: other.targetId }).catch(() => {});

  // a) oculta desde o início + ensureVisible
  for (const mode of ["com ensureVisible", "sem ensureVisible"]) {
    const page = await newPage(browser);
    await setDisplay(page.cdp, { width: 1280, height: 800, dpr: 1 });
    await navigate(page.cdp, `http://127.0.0.1:${port}/p/gsap-st`, { settleMs: 1800 });
    const other = await hide(page);
    const { entries, log } = collector();
    let calls = 0, image, error;
    const ctx = { log, report() {}, decodeStrip: nodeDecodeStrip };
    if (mode === "com ensureVisible") ctx.ensureVisible = async () => { calls++; await page.cdp.send("Page.bringToFront"); };
    const t0 = Date.now();
    try { image = await capturePage(page.cdp, ctx); } catch (e) { error = e; }
    const after = await evalIn(page.cdp, "({ y: scrollY, probe: typeof window.__fp })", false);
    if (mode === "com ensureVisible") {
      const png = image && decodePng(Buffer.from(await image.blob.arrayBuffer()));
      const s = png && scoreBlocks(png, expected("gsap-st", new URLSearchParams(), { vh: 800, port }), png.width / image.cssWidth);
      check("oculta + ensureVisible: captura com fidelidade total", image && s.ok === 8 && calls >= 1 && !!find(entries, "Aba visível"), image ? `${s.ok}/8, ensureVisible ${calls}x, ${((Date.now() - t0) / 1000).toFixed(1)} s` : error?.message);
    } else {
      check("oculta sem ensureVisible: erro claro (não captura degradada)", !image && /não pôde ser trazida à frente/.test(error?.message ?? ""), error?.message.slice(0, 100));
    }
    check(`oculta ${mode}: restauração`, after.y === 0 && after.probe === "undefined");
    await closeOther(other);
    await page.close();
  }

  // c) o usuário troca de aba NO MEIO da captura
  const page = await newPage(browser);
  await setDisplay(page.cdp, { width: 1280, height: 800, dpr: 1 });
  await navigate(page.cdp, `http://127.0.0.1:${port}/p/gsap-st`, { settleMs: 1800 });
  const { entries, log } = collector();
  let calls = 0;
  const run = capturePage(page.cdp, { log, report() {}, decodeStrip: nodeDecodeStrip, ensureVisible: async () => { calls++; await page.cdp.send("Page.bringToFront"); } });
  await sleep(1200);
  const other = await hide(page);
  let image, error;
  try { image = await run; } catch (e) { error = e; }
  const png = image && decodePng(Buffer.from(await image.blob.arrayBuffer()));
  const s = png && scoreBlocks(png, expected("gsap-st", new URLSearchParams(), { vh: 800, port }), png.width / image.cssWidth);
  check("troca de aba no meio: reativada e captura completa", image && s.ok === 8 && calls >= 1, image ? `${s.ok}/8, ensureVisible ${calls}x` : error?.message);
  await closeOther(other);
  await page.close();
}

// ------------------------------------------------------------------ T9: FocusGuard com stub de chrome.*
if (want("t9")) {
  console.log("\n== T9: FocusGuard (stub de chrome.tabs/windows)");
  const silent = { info() {}, warn() {}, error() {} };
  const make = ({ tab, win, activeInWindow, lastFocused, failRestore = false }) => {
    const calls = [];
    globalThis.chrome = {
      tabs: {
        get: async () => tab,
        query: async () => (activeInWindow ? [activeInWindow] : []),
        update: async (id, props) => { calls.push(["tabs.update", id, props]); if (failRestore && id !== tab.id) throw new Error("No tab with id"); return {}; },
      },
      windows: {
        get: async () => win,
        getLastFocused: async () => lastFocused,
        update: async (id, props) => { calls.push(["windows.update", id, props]); return {}; },
      },
    };
    return calls;
  };
  const tab = { id: 10, windowId: 1, active: false };
  let calls = make({ tab, win: { id: 1, focused: true, state: "normal" }, activeInWindow: { id: 20 } });
  let guard = new FocusGuard(10, silent);
  await guard.ensureVisible();
  check("aba inativa → ativa a aba", JSON.stringify(calls) === JSON.stringify([["tabs.update", 10, { active: true }]]), JSON.stringify(calls));
  calls.length = 0; await guard.restore();
  check("restore → reativa a aba anterior", JSON.stringify(calls) === JSON.stringify([["tabs.update", 20, { active: true }]]), JSON.stringify(calls));
  calls.length = 0; await guard.restore();
  check("restore é idempotente", calls.length === 0);

  calls = make({ tab: { id: 10, windowId: 1, active: true }, win: { id: 1, focused: false, state: "normal" }, lastFocused: { id: 2 } });
  guard = new FocusGuard(10, silent);
  await guard.ensureVisible();
  const focusCalls = JSON.stringify(calls);
  calls.length = 0; await guard.restore();
  check("janela sem foco → foca; restore devolve o foco à janela anterior", focusCalls === JSON.stringify([["windows.update", 1, { focused: true }]]) && JSON.stringify(calls) === JSON.stringify([["windows.update", 2, { focused: true }]]), focusCalls + " / " + JSON.stringify(calls));

  calls = make({ tab: { id: 10, windowId: 1, active: true }, win: { id: 1, focused: true, state: "minimized" } });
  guard = new FocusGuard(10, silent);
  await guard.ensureVisible();
  const c1 = JSON.stringify(calls);
  calls.length = 0; await guard.restore();
  check("janela minimizada → restaura; restore volta a minimizar", c1 === JSON.stringify([["windows.update", 1, { state: "normal" }]]) && JSON.stringify(calls) === JSON.stringify([["windows.update", 1, { state: "minimized" }]]), c1 + " / " + JSON.stringify(calls));

  calls = make({ tab: { id: 10, windowId: 1, active: true }, win: { id: 1, focused: true, state: "normal" } });
  guard = new FocusGuard(10, silent);
  await guard.ensureVisible(); await guard.restore();
  check("já visível e focada → nenhuma chamada (nada a desfazer)", calls.length === 0);

  calls = make({ tab, win: { id: 1, focused: true, state: "normal" }, activeInWindow: { id: 20 }, failRestore: true });
  guard = new FocusGuard(10, silent);
  await guard.ensureVisible();
  let threw = false;
  try { await guard.restore(); } catch { threw = true; }
  check("restore nunca lança (aba anterior fechada)", !threw);
  delete globalThis.chrome;
}

// ------------------------------------------------------------------ T10: costura com o decodificador do navegador
if (want("t10")) {
  console.log("\n== T10: costura no navegador (createImageBitmap/OffscreenCanvas/CompressionStream) vs captura integral");
  const js = stripTypeScriptTypes(readFileSync(join(import.meta.dirname, "..", "src/background/png-stitch.ts"), "utf8"));
  const srv = createServer((req, res) => {
    if (req.url === "/png-stitch.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    res.writeHead(200, { "content-type": "text/html" }).end("<html><body></body></html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const page = await newPage(browser);
  await setDisplay(page.cdp, { width: 1280, height: 800, dpr: 1 });
  await navigate(page.cdp, `http://127.0.0.1:${port}/p/gsap-st`, { settleMs: 2500 });
  // 3 faixas verticais a 2x + captura integral de referência
  const parts = [];
  const ys = [[0, 2000], [2000, 2000], [4000, 2500]];
  for (const [y, h] of ys) parts.push((await page.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width: 1265, height: h, scale: 2 } })).data);
  const ref = await page.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1265, height: 6500, scale: 2 } });
  const tab = await newPage(browser);
  await navigate(tab.cdp, `http://127.0.0.1:${srv.address().port}/`, { settleMs: 200 });
  const stitched = await evalIn(tab.cdp, `(async () => {
    const { stitchStrips } = await import("/png-stitch.js");
    const blobs = ${JSON.stringify(parts)}.map((b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: "image/png" }); });
    const t0 = performance.now(); const r = await stitchStrips(blobs);
    const buf = new Uint8Array(await r.blob.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
    return { w: r.width, h: r.height, ms: Math.round(performance.now() - t0), b64: btoa(s) };
  })()`);
  const d = diffPixels(decodePng(Buffer.from(stitched.b64, "base64")), decodePng(Buffer.from(ref.data, "base64")));
  check("PNG costurado no navegador é pixel-idêntico à captura integral", d.comparable && d.diff === 0, `${stitched.w}x${stitched.h} em ${stitched.ms} ms; ${JSON.stringify(d)}`);
  await tab.close(); await page.close(); srv.close();
}

// ------------------------------------------------------------------ resumo
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações OK`);
if (failed.length) console.log("FALHAS:\n" + failed.map((f) => " - " + f.name + (f.detail ? " — " + f.detail : "")).join("\n"));
writeFileSync(join(outDir, "phase1-results.json"), JSON.stringify(results, null, 1));
bws.close(); browser.kill(); server.close();
setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
