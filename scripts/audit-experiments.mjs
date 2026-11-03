// Experimentos de auditoria (Prompt 04). Medem comportamento do Chrome/CDP e comparam estratégias
// SEM alterar o algoritmo da extensão: usam as primitivas de src/background/page-prep.ts e o CDP
// cru. Os limites medidos valem para ESTE ambiente (Chrome instalado, headless, --disable-gpu =
// renderização por software) e não devem ser tratados como universais.
//
// Uso: node scripts/audit-experiments.mjs <pasta-saida> [--only=e1,e2,...]
//  e1 semântica de clip.scale | e2 limites de dimensão | e3 captura por faixas | e5 estratégias
//  e4 resize durante a captura | e6 passo de rolagem | e7 viewport alta | e8 aba em segundo plano
//  e9 pixels (copiar/PNG/PDF) | e10 captura ao vivo por faixas de viewport
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { inflateSync } from "node:zlib";
import { capturePage } from "../src/background/capture.ts";
import { installProbe, scrollDown, scrollTo, settle, waitForFonts } from "../src/background/page-prep.ts";
import { expected, startFixtureServer } from "./fixtures.mjs";
import { connect, evalIn, launch, navigate, newPage, setDisplay, sleep } from "./lib/browser.mjs";
import { colorBands, decodePng, scoreBlocks } from "./lib/png.mjs";

const [outDir, ...flags] = process.argv.slice(2);
if (!outDir) { console.error("Uso: node scripts/audit-experiments.mjs <pasta-saida> [--only=e1,e2]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const only = flags.find((f) => f.startsWith("--only="))?.slice(7).split(",");
const want = (id) => !only || only.includes(id);
const results = {};
const say = (...a) => console.log(...a);

const { server, port } = await startFixtureServer(0);
const origin = `http://127.0.0.1:${port}`;
const browser = await launch({ width: 1280, height: 800 });

const b64Of = async (img) => Buffer.from(await img.blob.arrayBuffer()).toString("base64");
const pngSize = (b64) => { const h = Buffer.from(b64.slice(0, 48), "base64"); return { width: h.readUInt32BE(16), height: h.readUInt32BE(20) }; };
async function openFixture(path, { dpr = 1, width = 1280, height = 800, settleMs = 1800 } = {}) {
  const page = await newPage(browser);
  await setDisplay(page.cdp, { width, height, dpr });
  await navigate(page.cdp, `${origin}${path}`, { settleMs });
  return page;
}
async function contentCss(cdp) {
  const m = await cdp.send("Page.getLayoutMetrics");
  const c = m.cssContentSize ?? m.contentSize;
  return { width: Math.ceil(c.width), height: Math.ceil(c.height) };
}
async function shoot(cdp, { x = 0, y = 0, width, height, scale = 1 }) {
  const t0 = Date.now();
  try {
    const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { x, y, width, height, scale } });
    return { ok: true, ms: Date.now() - t0, b64: r.data, ...pngSize(r.data), bytes: Math.floor((r.data.length * 3) / 4) };
  } catch (error) { return { ok: false, ms: Date.now() - t0, error: error.message }; }
}
const diffPng = (a, b, tol = 3) => {
  if (a.width !== b.width || a.height !== b.height) return { comparable: false, a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` };
  let diff = 0, max = 0;
  for (let i = 0; i < a.data.length; i += a.channels) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > tol) diff++;
    if (d > max) max = d;
  }
  return { comparable: true, differingPixels: diff, ofPixels: a.width * a.height, maxChannelDelta: max };
};
const stitch = (parts) => {
  const width = parts[0].width, channels = parts[0].channels;
  const height = parts.reduce((s, p) => s + p.height, 0);
  const data = Buffer.alloc(width * height * channels);
  let off = 0;
  for (const p of parts) { p.data.copy(data, off); off += p.data.length; }
  return { width, height, channels, data };
};

// ---------------------------------------------------------------- E1
if (want("e1")) {
  say("\n=== E1: semântica de clip.scale × devicePixelRatio (página estática, 6 seções)");
  const rows = [];
  const grabs = {};
  for (const dpr of [1, 2]) {
    const page = await openFixture("/p/static", { dpr });
    const { cdp } = page;
    const css = await contentCss(cdp);
    for (const scale of dpr === 1 ? [0.5, 1, 2] : [0.5, 1, 2]) {
      const r = await shoot(cdp, { ...css, scale });
      rows.push({ displayDpr: dpr, clipScale: scale, css: `${css.width}x${css.height}`, png: r.ok ? `${r.width}x${r.height}` : r.error, effective: r.ok ? +(r.width / css.width).toFixed(3) : null, ms: r.ms });
      if (r.ok) grabs[`${dpr}/${scale}`] = r.b64;
    }
    await page.close();
  }
  console.table(rows);
  const a = decodePng(Buffer.from(grabs["1/2"], "base64")), b = decodePng(Buffer.from(grabs["2/1"], "base64"));
  const equality = diffPng(a, b);
  say("Igualdade de pixels  (dpr1, clip.scale 2)  vs  (dpr2, clip.scale 1):", JSON.stringify(equality));
  results.e1 = { rows, equality };
}

// ---------------------------------------------------------------- E2
if (want("e2")) {
  say("\n=== E2: limites de dimensão neste ambiente (captura direta, sem preparação)");
  const rows = [];
  const cases = [
    ...[4000, 6000, 8000, 8192, 8500, 10000, 16000, 20000, 32000].map((h) => ({ width: 400, h })),
    ...[8000, 8500, 12000].map((h) => ({ width: 1280, h })),
  ];
  for (const [dpr, scale] of [[2, 1], [1, 2]]) {
    for (const { width, h } of cases) {
      const page = await openFixture(`/p/very-long?h=${h}`, { dpr, width, settleMs: 300 });
      const css = await contentCss(page.cdp);
      const r = await shoot(page.cdp, { ...css, scale });
      const row = { effective: dpr * scale, cssWidth: css.width, cssHeight: css.height, expectedPx: `${css.width * 2}x${css.height * 2}`, result: r.ok ? `${r.width}x${r.height}` : "ERRO: " + r.error.slice(0, 70), ms: r.ms, MB: r.ok ? +(r.bytes / 1e6).toFixed(2) : null };
      if (r.ok) {
        const exact = r.width === css.width * 2 && r.height === css.height * 2;
        let bottomOk = null;
        try {
          const png = decodePng(Buffer.from(r.b64, "base64"));
          const blocks = expected("very-long", new URLSearchParams({ h }));
          const last = blocks.slice(-3);
          bottomOk = scoreBlocks(png, last, png.width / css.width).ok === last.length;
        } catch (e) { bottomOk = "decode: " + e.message.slice(0, 40); }
        row.dimensoesExatas = exact; row.ultimosBlocosOk = bottomOk;
      }
      rows.push(row);
      await page.close();
    }
  }
  console.table(rows);
  results.e2 = rows;
}

// ---------------------------------------------------------------- E3
if (want("e3")) {
  say("\n=== E3: captura por faixas (clip em y) — emenda, limite, fixed/sticky, vh");
  const out = {};
  // A) igualdade faixas × captura única (8000 css × 1280, 2x)
  for (const [dpr, scale] of [[2, 1], [1, 2]]) {
    const page = await openFixture("/p/very-long?h=8000", { dpr, settleMs: 300 });
    const css = await contentCss(page.cdp);
    const single = await shoot(page.cdp, { ...css, scale });
    const t0 = Date.now();
    const parts = [];
    for (let y = 0; y < css.height; y += 2000) {
      const r = await shoot(page.cdp, { y, width: css.width, height: Math.min(2000, css.height - y), scale });
      parts.push(decodePng(Buffer.from(r.b64, "base64")));
    }
    const stitched = stitch(parts);
    const eq = single.ok ? diffPng(decodePng(Buffer.from(single.b64, "base64")), stitched) : { comparable: false, note: "captura única falhou: " + single.error };
    out[`A(${dpr}x,scale${scale})`] = { single: single.ok ? `${single.width}x${single.height}` : single.error, strips: `${stitched.width}x${stitched.height}`, stripsMs: Date.now() - t0, singleMs: single.ms, equality: eq };
    await page.close();
  }
  // B) além do limite: 30000 css × 400 (2x => 60000 px de altura), faixas de 4000 css
  for (const [dpr, scale] of [[2, 1], [1, 2]]) {
    const page = await openFixture("/p/very-long?h=30000", { dpr, width: 400, settleMs: 300 });
    const css = await contentCss(page.cdp);
    const blocks = expected("very-long", new URLSearchParams({ h: 30000 }));
    let ok = 0, total = 0, ms = 0, mb = 0, errors = [];
    for (let y = 0; y < css.height; y += 4000) {
      const r = await shoot(page.cdp, { y, width: css.width, height: Math.min(4000, css.height - y), scale });
      ms += r.ms;
      if (!r.ok) { errors.push(r.error.slice(0, 60)); continue; }
      mb += r.bytes / 1e6;
      const png = decodePng(Buffer.from(r.b64, "base64"));
      const local = blocks.filter((b) => b.y >= y && b.y + b.h <= y + 4000).map((b) => ({ ...b, y: b.y - y }));
      const s = scoreBlocks(png, local, png.width / css.width);
      ok += s.ok; total += s.total;
    }
    out[`B(${dpr}x,scale${scale}) 30000 css`] = { blocosOk: `${ok}/${total}`, strips: Math.ceil(css.height / 4000), totalMs: ms, MB: +mb.toFixed(2), errors };
    await page.close();
  }
  // C) fixed/sticky: captura única vs faixas de 1200 css
  {
    const page = await openFixture("/p/sticky-fixed", { dpr: 1 });
    const css = await contentCss(page.cdp);
    const scan = (png, y0 = 0) => ({
      rodapeFixo: colorBands(png, Math.floor(640 * (png.width / css.width)), "#ff00ff").map(([a, b]) => `${y0 + a}–${y0 + b}`),
      sidebarSticky: colorBands(png, Math.floor(100 * (png.width / css.width)), "#00ffff").map(([a, b]) => `${y0 + a}–${y0 + b}`),
      headerFixo: colorBands(png, Math.floor(640 * (png.width / css.width)), "#222222").map(([a, b]) => `${y0 + a}–${y0 + b}`).slice(0, 4),
    });
    const single = await shoot(page.cdp, { ...css, scale: 1 });
    out["C única"] = { css: `${css.width}x${css.height}`, ...scan(decodePng(Buffer.from(single.b64, "base64"))) };
    for (let y = 0; y < css.height; y += 1200) {
      const r = await shoot(page.cdp, { y, width: css.width, height: Math.min(1200, css.height - y), scale: 1 });
      out[`C faixa y=${y}`] = scan(decodePng(Buffer.from(r.b64, "base64")), y);
    }
    await page.close();
  }
  // D) vh: captura única vs faixas (pontuação dos blocos)
  {
    const page = await openFixture("/p/vh", { dpr: 1 });
    const css = await contentCss(page.cdp);
    const vh = await evalIn(page.cdp, "innerHeight", false);
    const blocks = expected("vh", new URLSearchParams(), { vh });
    const single = await shoot(page.cdp, { ...css, scale: 1 });
    const s1 = scoreBlocks(decodePng(Buffer.from(single.b64, "base64")), blocks, 1 * decodePng(Buffer.from(single.b64, "base64")).width / css.width);
    const parts = [];
    for (let y = 0; y < css.height; y += 1200) {
      const r = await shoot(page.cdp, { y, width: css.width, height: Math.min(1200, css.height - y), scale: 1 });
      parts.push(decodePng(Buffer.from(r.b64, "base64")));
    }
    const st = stitch(parts);
    const s2 = scoreBlocks(st, blocks, st.width / css.width);
    out["D vh"] = { vh, unica: `${s1.ok}/${s1.total}`, faixas: `${s2.ok}/${s2.total}`, faixasDiferemDaUnica: diffPng(decodePng(Buffer.from(single.b64, "base64")), st) };
    await page.close();
  }
  console.log(JSON.stringify(out, null, 1));
  results.e3 = out;
}

// ---------------------------------------------------------------- E5/E6/E7
const STRAT_FIXTURES = ["static", "lazy-long", "gsap-st", "io-css", "spa-vue", "sticky-fixed", "iframes"];
const score = async (page, name, b64, extra = {}) => {
  const png = decodePng(Buffer.from(b64, "base64"));
  const vh = await evalIn(page.cdp, "innerHeight", false);
  const css = extra.cssWidth ?? png.width / 2;
  const s = scoreBlocks(png, expected(name, new URLSearchParams(), { vh, port }), png.width / css);
  return { blocks: `${s.ok}/${s.total}`, failed: s.failed.join(",") };
};
async function scrollPass(cdp, stridePct, delayMs) {
  // Variante parametrizável do scrollDown (a atual usa 0.75 da viewport e 150 ms).
  const t0 = Date.now();
  let y = 0, steps = 0;
  for (;;) {
    const m = await evalIn(cdp, `window.__fp.metrics(${y})`, false);
    steps++;
    await sleep(delayMs);
    if (y + m.viewportHeight >= m.scrollHeight - 1) {
      await sleep(Math.max(delayMs, 400));
      const after = await evalIn(cdp, `window.__fp.metrics(${y})`, false);
      if (after.scrollHeight <= m.scrollHeight) break;
    }
    y += Math.max(200, Math.floor(m.viewportHeight * stridePct));
    if (steps > 400) break;
  }
  return { steps, ms: Date.now() - t0 };
}

if (want("e5")) {
  say("\n=== E5: estratégias (display 2x, clip.scale 1) — fidelidade por pixel e tempo");
  const rows = [];
  for (const name of STRAT_FIXTURES) {
    for (const strategy of ["S0 direta", "S1 rolar+topo", "S2 atual"]) {
      const page = await openFixture(`/p/${name}`, { dpr: 2, settleMs: 2000 });
      const { cdp } = page;
      const t0 = Date.now();
      let b64, err, cssWidth;
      try {
        if (strategy === "S2 atual") {
          const img = await capturePage(cdp, { log: { info() {}, warn() {}, error() {} }, report() {} });
          b64 = await b64Of(img); cssWidth = img.cssWidth;
        } else {
          await cdp.send("Page.enable");
          if (strategy === "S1 rolar+topo") {
            await installProbe(cdp);
            await waitForFonts(cdp);
            await scrollDown(cdp, () => {});
            await settle(cdp, 400, 8000);
            await scrollTo(cdp, { x: 0, y: 0 });
            await sleep(150);
            await settle(cdp, 400, 8000);
          }
          const css = await contentCss(cdp);
          cssWidth = css.width;
          b64 = (await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, ...css, scale: 1 } })).data;
        }
      } catch (e) { err = e.message; }
      const row = { fixture: name, estrategia: strategy, ms: Date.now() - t0 };
      if (b64) { const s = await score(page, name, b64, { cssWidth }); Object.assign(row, s, pngSize(b64)); } else row.erro = err.slice(0, 80);
      rows.push(row);
      await page.close();
    }
  }
  console.table(rows.map((r) => ({ fixture: r.fixture, estrategia: r.estrategia, blocos: r.blocks ?? r.erro, falhas: r.failed ?? "", png: r.width ? `${r.width}x${r.height}` : "", ms: r.ms })));
  results.e5 = rows;
}

if (want("e6")) {
  say("\n=== E6: passo e atraso da rolagem (S1: rolar+topo, display 2x)");
  const rows = [];
  for (const name of ["lazy-long", "io-css", "spa-vue", "gsap-st"]) {
    for (const [stride, delay] of [[0.75, 150], [1, 150], [1, 50], [1.5, 100], [3, 100]]) {
      const page = await openFixture(`/p/${name}`, { dpr: 2, settleMs: 2000 });
      const { cdp } = page;
      await cdp.send("Page.enable");
      await installProbe(cdp);
      await waitForFonts(cdp);
      const pass = await scrollPass(cdp, stride, delay);
      await settle(cdp, 400, 8000);
      await scrollTo(cdp, { x: 0, y: 0 });
      await sleep(150);
      await settle(cdp, 400, 8000);
      const css = await contentCss(cdp);
      const b64 = (await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, ...css, scale: 1 } })).data;
      const s = await score(page, name, b64, { cssWidth: css.width });
      rows.push({ fixture: name, passoViewport: stride, atrasoMs: delay, passos: pass.steps, rolagemMs: pass.ms, blocos: s.blocks, falhas: s.failed });
      await page.close();
    }
  }
  console.table(rows);
  results.e6 = rows;
}

if (want("e7")) {
  say("\n=== E7: viewport alta (sem rolar) — setDeviceMetricsOverride com a altura do documento");
  const rows = [];
  for (const name of ["static", "lazy-long", "gsap-st", "io-css", "spa-vue", "sticky-fixed", "vh"]) {
    const page = await openFixture(`/p/${name}`, { dpr: 2, settleMs: 2000 });
    const { cdp } = page;
    const t0 = Date.now();
    const h0 = await evalIn(cdp, "document.documentElement.scrollHeight", false);
    const height = Math.min(h0, 16000);
    await setDisplay(cdp, { width: 1280, height, dpr: 2 });
    await sleep(1500);
    const st = await settle(cdp, 400, 8000).catch(() => null);
    // (settle precisa do probe; sem ele, só espera fixa)
    await sleep(500);
    const css = await contentCss(cdp);
    const b64 = (await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, ...css, scale: 1 } })).data;
    const vh = await evalIn(cdp, "innerHeight", false);
    const png = decodePng(Buffer.from(b64, "base64"));
    const s = scoreBlocks(png, expected(name, new URLSearchParams(), { vh: 800, port }), png.width / css.width);
    await setDisplay(cdp, { width: 1280, height: 800, dpr: 2 });
    rows.push({ fixture: name, alturaOriginal: h0, alturaDepois: css.height, vhDuranteCaptura: vh, blocos: `${s.ok}/${s.total}`, falhas: s.failed.join(","), ms: Date.now() - t0, st: st ? "ok" : "sem probe" });
    await page.close();
  }
  console.table(rows);
  results.e7 = rows;
}

// ---------------------------------------------------------------- E8
if (want("e8")) {
  say("\n=== E8: aba em segundo plano");
  const out = {};
  const bws = connect((await browser.json("/json/version")).webSocketDebuggerUrl);
  await bws.opened;
  for (const name of ["gsap-st", "io-css"]) {
    const page = await openFixture(`/p/${name}`, { dpr: 2, settleMs: 2000 });
    const other = await bws.send("Target.createTarget", { url: "about:blank" });
    await bws.send("Target.activateTarget", { targetId: other.targetId });
    await sleep(800);
    const vis = await evalIn(page.cdp, "({ state: document.visibilityState, hidden: document.hidden })", false);
    let rafTicks = 0;
    rafTicks = await evalIn(page.cdp, "new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 600) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); setTimeout(() => r(n), 900); })");
    const entry = { visibilityState: vis.state, rafEm600ms: rafTicks };
    const t0 = Date.now();
    try {
      const img = await capturePage(page.cdp, { log: { info() {}, warn() {}, error() {} }, report() {} });
      const s = await score(page, name, await b64Of(img), { cssWidth: img.cssWidth });
      Object.assign(entry, { captura: "ok", blocos: s.blocks, falhas: s.failed });
    } catch (e) { entry.captura = "ERRO: " + e.message.slice(0, 100); }
    entry.ms = Date.now() - t0;
    out[name] = entry;
    await bws.send("Target.closeTarget", { targetId: other.targetId }).catch(() => {});
    await page.close();
  }
  bws.close();
  console.log(JSON.stringify(out, null, 1));
  results.e8 = out;
}

// ---------------------------------------------------------------- E9
if (want("e9")) {
  say("\n=== E9: preservação de pixels (captura → Copiar imagem → Salvar PNG → Salvar PDF), imagem 2x");
  const dist = join(import.meta.dirname, "..", "dist");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const staticServer = createServer((req, res) => {
    const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
    let body; try { body = readFileSync(join(dist, path)); } catch { return res.writeHead(404).end("nf"); } res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
  });
  await new Promise((r) => staticServer.listen(0, "127.0.0.1", r));
  const distOrigin = `http://127.0.0.1:${staticServer.address().port}`;

  // 1) captura 2x com o algoritmo atual
  const src = await openFixture("/p/gsap-st", { dpr: 2, settleMs: 2000 });
  const img = await capturePage(src.cdp, { log: { info() {}, warn() {}, error() {} }, report() {} });
  await src.close();
  const original = Buffer.from(await img.blob.arrayBuffer());
  const imgB64 = original.toString("base64");
  writeFileSync(join(outDir, "e9-original.png"), original);
  const dl = join(outDir, "e9-downloads"); mkdirSync(dl, { recursive: true });

  const bws = connect((await browser.json("/json/version")).webSocketDebuggerUrl); await bws.opened;
  await bws.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl.replace(/\//g, "\\") });
  await bws.send("Browser.grantPermissions", { origin: distOrigin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  const page = await newPage(browser);
  const { cdp } = page;
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await navigate(cdp, `${distOrigin}/preview/preview.html?id=none`, { settleMs: 300 });
  await evalIn(cdp, `(async () => {
    const bin = atob("${imgB64}"); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const db = await new Promise((res, rej) => { const r = indexedDB.open("full-print", 1); r.onupgradeneeded = () => r.result.createObjectStore("captures", { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction("captures", "readwrite"); tx.objectStore("captures").put({ id: "e9", createdAt: Date.now(), pageUrl: "http://x/", width: ${img.width}, height: ${img.height}, cssWidth: ${img.cssWidth}, cssHeight: ${img.cssHeight}, dpr: 2, blob: new Blob([bytes], { type: "image/png" }) }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close(); })()`);
  await navigate(cdp, `${distOrigin}/preview/preview.html?id=e9`, { settleMs: 500 });
  const out = { original: `${img.width}x${img.height}, ${original.length} bytes` };

  // 2) Copiar imagem: compara pixels decodificados (original × área de transferência) no navegador
  await evalIn(cdp, "document.getElementById('copy').click()", false);
  await sleep(1500);
  out.copiar = await evalIn(cdp, `(async () => {
    const items = await navigator.clipboard.read(); const clip = await items[0].getType("image/png");
    const orig = await (await fetch(document.getElementById('image').src)).blob();
    const px = async (b) => { const bm = await createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" }); const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" }); g.drawImage(bm, 0, 0); return { w: bm.width, h: bm.height, d: g.getImageData(0, 0, bm.width, bm.height).data }; };
    const a = await px(orig), b = await px(clip);
    let diff = 0, max = 0;
    if (a.w === b.w && a.h === b.h) for (let i = 0; i < a.d.length; i += 4) { const d = Math.max(Math.abs(a.d[i] - b.d[i]), Math.abs(a.d[i + 1] - b.d[i + 1]), Math.abs(a.d[i + 2] - b.d[i + 2]), Math.abs(a.d[i + 3] - b.d[i + 3])); if (d) diff++; if (d > max) max = d; }
    return { originalPx: a.w + "x" + a.h, clipboardPx: b.w + "x" + b.h, clipboardBytes: clip.size, pixelsDiferentes: diff, maiorDiferencaCanal: max, tipos: items[0].types };
  })()`);

  // 3) Salvar PNG: hash do arquivo baixado
  await evalIn(cdp, "document.getElementById('save-png').click()", false);
  await sleep(1500);
  // 4) Salvar PDF: extrai as faixas de imagem do PDF e compara com o RGB do PNG
  await evalIn(cdp, "document.getElementById('save-pdf').click()", false);
  for (let i = 0; i < 60 && !readdirSync(dl).some((f) => f.endsWith(".pdf")); i++) await sleep(500);
  await sleep(800);
  const files = readdirSync(dl);
  const pngFile = files.find((f) => f.endsWith(".png")), pdfFile = files.find((f) => f.endsWith(".pdf"));
  out.salvarPng = pngFile ? { arquivo: pngFile, identicoAoOriginal: createHash("sha256").update(readFileSync(join(dl, pngFile))).digest("hex") === createHash("sha256").update(original).digest("hex") } : "nenhum arquivo";
  if (pdfFile) {
    const pdf = readFileSync(join(dl, pdfFile));
    const text = pdf.toString("latin1");
    const strips = [];
    const re = /(\d+) 0 obj\n<< \/Type \/XObject \/Subtype \/Image \/Width (\d+) \/Height (\d+) [^>]*?\/Length (\d+) >>\nstream\n/g;
    let m;
    while ((m = re.exec(text))) { const start = m.index + m[0].length; strips.push({ id: +m[1], w: +m[2], h: +m[3], data: inflateSync(pdf.subarray(start, start + +m[4])) }); }
    strips.sort((a, b) => a.id - b.id);
    const png = decodePng(original);
    let identical = strips.length > 0 && strips.every((s) => s.w === png.width), row = 0, diffBytes = 0;
    for (const s of strips) {
      for (let y = 0; y < s.h && identical; y++) for (let x = 0; x < s.w; x++) {
        const o = (y * s.w + x) * 3, p = ((row + y) * png.width + x) * png.channels;
        if (s.data[o] !== png.data[p] || s.data[o + 1] !== png.data[p + 1] || s.data[o + 2] !== png.data[p + 2]) { diffBytes++; }
      }
      row += s.h;
    }
    out.salvarPdf = { arquivo: pdfFile, bytes: pdf.length, faixas: strips.length, linhasNoPdf: row, linhasNoPng: png.height, pixelsDiferentes: diffBytes, sem_perdas: row === png.height && diffBytes === 0 };
  } else out.salvarPdf = "nenhum arquivo";
  console.log(JSON.stringify(out, null, 1));
  results.e9 = out;
  await page.close(); bws.close(); staticServer.close();
}


// ---------------------------------------------------------------- E4
if (want("e4")) {
  say("\n=== E4: o que a página enxerga durante Page.captureScreenshot (captureBeyondViewport)");
  const out = {};
  for (const dpr of [1, 2]) {
    const page = await openFixture("/p/static", { dpr, settleMs: 800 });
    const { cdp } = page;
    await evalIn(cdp, "(() => { const log = window.__ev = []; const t0 = performance.now(); const snap = (k) => log.push({ k, t: Math.round(performance.now() - t0), w: innerWidth, h: innerHeight, dpr: devicePixelRatio, vvw: visualViewport.width, vvh: visualViewport.height, vw100: document.documentElement.clientWidth, narrow: matchMedia('(max-width: 700px)').matches }); addEventListener('resize', () => snap('resize')); visualViewport.addEventListener('resize', () => snap('visualViewport.resize')); matchMedia('(max-width: 700px)').addEventListener('change', () => snap('mediaquery-change')); snap('inicio'); })()", false);
    const css = await contentCss(cdp);
    const r = await shoot(cdp, { ...css, scale: 1 });
    await sleep(600);
    out["dpr" + dpr] = { png: r.ok ? r.width + "x" + r.height : r.error, eventos: await evalIn(cdp, "window.__ev", false) };
    await page.close();
  }
  console.log(JSON.stringify(out, null, 1));
  results.e4 = out;
}

// ---------------------------------------------------------------- E10
if (want("e10")) {
  say("\n=== E10: captura 'ao vivo' por faixas de viewport (rolar → assentar → capturar a janela → costurar), display 2x");
  const rows = [];
  for (const name of ["io-css", "gsap-st", "sticky-fixed", "lazy-long", "iframes"]) {
    const page = await openFixture("/p/" + name, { dpr: 2, settleMs: 2000 });
    const { cdp } = page;
    await cdp.send("Page.enable");
    await installProbe(cdp);
    await waitForFonts(cdp);
    const t0 = Date.now();
    const parts = [];
    let y = 0, bands = 0;
    for (;;) {
      const m = await evalIn(cdp, "window.__fp.metrics(" + y + ")", false);
      await sleep(150);
      await settle(cdp, 300, 4000);
      const at = await evalIn(cdp, "({ y: scrollY, vh: innerHeight, h: document.documentElement.scrollHeight, w: document.documentElement.clientWidth })", false);
      const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true, clip: { x: 0, y: at.y, width: at.w, height: Math.min(at.vh, at.h - at.y), scale: 1 } });
      const png = decodePng(Buffer.from(r.data, "base64"));
      // a última faixa pode se sobrepor à anterior (scroll limitado): mantém só as linhas novas
      const doneRows = parts.reduce((s, p) => s + p.height, 0);
      const startRow = Math.max(0, Math.round(at.y * 2) - doneRows);
      parts.push(startRow ? { ...png, height: png.height - startRow, data: png.data.subarray(startRow * png.width * png.channels) } : png);
      bands++;
      if (at.y + at.vh >= at.h - 1 || bands > 60) break;
      y = at.y + at.vh;
    }
    const st = stitch(parts);
    const css = await contentCss(cdp);
    const vh = await evalIn(cdp, "innerHeight", false);
    const s = scoreBlocks(st, expected(name, new URLSearchParams(), { vh, port }), st.width / css.width);
    const row = { fixture: name, faixas: bands, ms: Date.now() - t0, png: st.width + "x" + st.height, blocos: s.ok + "/" + s.total, falhas: s.failed.join(",") };
    if (name === "sticky-fixed") {
      const sc = st.width / css.width;
      row.headerFixoRepetido = colorBands(st, Math.floor(640 * sc), "#222222").length + " faixas escuras";
      row.rodapeFixo = colorBands(st, Math.floor(640 * sc), "#ff00ff").map(([a, b]) => Math.round(a / sc) + "–" + Math.round(b / sc)).join(" | ");
    }
    rows.push(row);
    await page.close();
  }
  console.table(rows);
  results.e10 = rows;
}


// ---------------------------------------------------------------- E2b
if (want("e2b")) {
  say("\n=== E2b: procurando o ponto de ruptura (captura direta, 2x via clip.scale em display 1x)");
  const rows = [];
  for (const { width, h } of [{ width: 1280, h: 16000 }, { width: 1280, h: 24000 }, { width: 1280, h: 32000 }, { width: 400, h: 50000 }, { width: 400, h: 100000 }]) {
    const page = await openFixture("/p/very-long?h=" + h, { dpr: 1, width, settleMs: 300 });
    const css = await contentCss(page.cdp);
    const r = await shoot(page.cdp, { ...css, scale: 2 });
    const px = css.width * 2 * css.height * 2;
    const row = { css: css.width + "x" + css.height, esperado: css.width * 2 + "x" + css.height * 2, MP: Math.round(px / 1e4) / 100, resultado: r.ok ? r.width + "x" + r.height : "ERRO: " + r.error.slice(0, 90), ms: r.ms, MB: r.ok ? +(r.bytes / 1e6).toFixed(2) : null };
    if (r.ok) {
      row.dimensoesExatas = r.width === css.width * 2 && r.height === css.height * 2;
      if (px <= 130e6) {
        const png = decodePng(Buffer.from(r.b64, "base64"));
        const blocks = expected("very-long", new URLSearchParams({ h })).slice(-3);
        row.ultimosBlocosOk = scoreBlocks(png, blocks, png.width / css.width).ok === blocks.length;
      } else row.ultimosBlocosOk = "não verificado (>130 MP)";
    }
    rows.push(row);
    await page.close();
  }
  console.table(rows);
  results.e2b = rows;
}

// ---------------------------------------------------------------- E8b
if (want("e8b")) {
  say("\n=== E8b: aba em segundo plano — o que recupera a fidelidade?");
  const out = {};
  const bws = connect((await browser.json("/json/version")).webSocketDebuggerUrl);
  await bws.opened;
  for (const remedy of ["nenhum", "setWebLifecycleState(active)", "bringToFront"]) {
    const page = await openFixture("/p/gsap-st", { dpr: 2, settleMs: 2000 });
    const other = await bws.send("Target.createTarget", { url: "about:blank" });
    await bws.send("Target.activateTarget", { targetId: other.targetId });
    await sleep(800);
    if (remedy.startsWith("setWebLifecycleState")) await page.cdp.send("Page.setWebLifecycleState", { state: "active" }).catch((e) => (out.erroLifecycle = e.message));
    if (remedy === "bringToFront") { await page.cdp.send("Page.bringToFront"); await sleep(500); }
    const vis = await evalIn(page.cdp, "document.visibilityState", false);
    const t0 = Date.now();
    const entry = { visibilityState: vis };
    try {
      const img = await capturePage(page.cdp, { log: { info() {}, warn() {}, error() {} }, report() {} });
      const s = await score(page, "gsap-st", await b64Of(img), { cssWidth: img.cssWidth });
      Object.assign(entry, { blocos: s.blocks, falhas: s.failed });
    } catch (e) { entry.erro = e.message.slice(0, 100); }
    entry.ms = Date.now() - t0;
    entry.visibilityDepois = await evalIn(page.cdp, "document.visibilityState", false);
    out[remedy] = entry;
    await bws.send("Target.closeTarget", { targetId: other.targetId }).catch(() => {});
    await page.close();
  }
  bws.close();
  console.log(JSON.stringify(out, null, 1));
  results.e8b = out;
}

writeFileSync(join(outDir, "experiments-results.json"), JSON.stringify(results, null, 1));
browser.kill(); server.close();
setTimeout(() => process.exit(0), 500);
