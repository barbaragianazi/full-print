// Matriz de compatibilidade: executa o algoritmo ATUAL (src/background/capture.ts, sem alterações)
// contra fixtures locais e, opcionalmente, sites reais, em Chrome headless. Mede resolução, tempos
// por fase, fidelidade por pixel (blocos de cor conhecidos), restauração e erros.
// Não testa chrome.debugger/popup/prévia (isso exige a extensão instalada).
//
// Uso: node scripts/audit.mjs <pasta-saida> [--real] [--only=id1,id2]
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capturePage } from "../src/background/capture.ts";
import { expected, startFixtureServer } from "./fixtures.mjs";
import { launch, newPage, navigate, evalIn, setDisplay, sleep } from "./lib/browser.mjs";
import { nodeDecodeStrip } from "./lib/node-decode.mjs";
import { colorBands, decodePng, hexToRgb, close, pixelAt, scoreBlocks } from "./lib/png.mjs";

const [outDir, ...flags] = process.argv.slice(2);
if (!outDir) { console.error("Uso: node scripts/audit.mjs <pasta-saida> [--real] [--only=a,b]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const only = flags.find((f) => f.startsWith("--only="))?.slice(7).split(",");
const withReal = flags.includes("--real");

const VIEW = { width: 1280, height: 800 };
const fixtures = [
  { id: "static", path: "/p/static", note: "Página estática simples" },
  { id: "lazy-long", path: "/p/lazy-long", note: "Longa: lazy nativo + IntersectionObserver + rolagem infinita" },
  { id: "lazy-long@4000", path: "/p/lazy-long", startY: 4000, dprs: [2], note: "Idem, com a aba rolada a 4000 px" },
  { id: "gsap-st", path: "/p/gsap-st", note: "GSAP + ScrollTrigger (replay/reset, scrub, pin)" },
  { id: "gsap-st@1800", path: "/p/gsap-st", startY: 1800, dprs: [2], note: "Idem, aba rolada a 1800 px" },
  { id: "io-css", path: "/p/io-css", note: "IntersectionObserver (once/replay), CSS animations, scroll-driven CSS" },
  { id: "io-css@1800", path: "/p/io-css", startY: 1800, dprs: [2], note: "Idem, aba rolada a 1800 px" },
  { id: "spa-vue", path: "/p/spa-vue", note: "SPA Vue 3 (render tardio + montagem por IntersectionObserver)" },
  { id: "sticky-fixed", path: "/p/sticky-fixed", note: "fixed (header/rodapé) e sticky (sidebar)" },
  { id: "iframes", path: "/p/iframes", note: "iframes: mesma origem, srcdoc, cross-origin, lazy" },
  { id: "vh", path: "/p/vh", note: "Seções 100vh (sensível a redimensionamento da viewport)" },
  { id: "very-long-8000", path: "/p/very-long?h=8000", note: "8000 px CSS (16000 px a 2x)" },
  { id: "very-long-9000", path: "/p/very-long?h=9000", note: "9000 px CSS (18000 px a 2x)" },
  { id: "very-long-20000", path: "/p/very-long?h=20000", note: "20000 px CSS" },
  { id: "image", path: "/photo.png", noBlocks: true, note: "Imagem PNG 1600×1200 aberta direto no navegador" },
];
const real = [
  { id: "real:gsap.com", url: "https://gsap.com/", dprs: [2], note: "Site real com GSAP/ScrollTrigger" },
  { id: "real:react.dev", url: "https://react.dev/", dprs: [2], note: "Site real React (SPA/SSR)" },
  { id: "real:vuejs.org", url: "https://vuejs.org/", dprs: [2], note: "Site real Vue" },
  { id: "real:wikipedia", url: "https://en.wikipedia.org/wiki/Web_page", dprs: [2], note: "Página real longa e estática" },
];

const { server, port } = await startFixtureServer(0);
const browser = await launch(VIEW);
const rows = [];

function collector() {
  const entries = [];
  const push = (level) => (message, data) => entries.push({ level, message, data });
  return { entries, log: { info: push("info"), warn: push("warn"), error: push("error") } };
}
const find = (entries, prefix) => entries.find((e) => e.message.startsWith(prefix));

async function run(item, dpr) {
  const id = `${item.id}|dpr${dpr}`;
  if (only && !only.includes(item.id)) return;
  const url = item.url ?? `http://127.0.0.1:${port}${item.path}`;
  const { cdp, close: closePage } = await newPage(browser);
  const row = { id: item.id, dpr, note: item.note, url: item.url ?? item.path };
  try {
    await setDisplay(cdp, { ...VIEW, dpr });
    await navigate(cdp, url, { settleMs: item.url ? 4000 : 2000 });
    if (item.startY) { await evalIn(cdp, `window.scrollTo({top:${item.startY},behavior:'instant'})`, false); await sleep(2000); }
    const before = await evalIn(cdp, "({ y: scrollY, vh: innerHeight, h: document.documentElement.scrollHeight })", false);
    row.startY = before.y;
    row.docHeightBefore = before.h;

    const { entries, log } = collector();
    let image;
    const t0 = Date.now();
    try {
      image = await capturePage(cdp, { log, report: () => {}, decodeStrip: nodeDecodeStrip });
    } catch (error) {
      row.error = error.message;
    }
    row.elapsedMs = Date.now() - t0;

    const after = await evalIn(cdp, "({ y: scrollY, probe: typeof window.__fp })", false);
    row.scrollRestored = after.y === before.y;
    row.probeRemoved = after.probe === "undefined";
    const geo = find(entries, "Geometria inicial")?.data, png = find(entries, "PNG capturado")?.data;
    const restore = find(entries, "Estado restaurado");
    row.cssWidth = image?.cssWidth ?? Number(geo?.css?.split("x")[0]); row.cssHeight = image?.cssHeight ?? Number(geo?.css?.split("x")[1]);
    row.pngWidth = png?.width; row.pngHeight = png?.height;
    row.effectiveScale = png?.escalaEfetiva; row.megapixels = png?.megapixels; row.bytes = png?.bytes; row.strategy = png?.estrategia; row.bands = png?.faixas;
    row.timings = find(entries, "Tempos (ms)")?.data;
    row.resize = find(entries, "Redimensionamentos")?.data?.resize;
    row.restore = restore ? { identical: restore.level === "info", changed: restore.data?.changed, sample: restore.data?.sample } : null;
    row.translucentAtCapture = find(entries, "Estado no momento da captura")?.data?.translucent;
    row.scrollTriggers = find(entries, "ScrollTriggers")?.data;
    row.warnings = entries.filter((e) => e.level === "warn").map((e) => e.message);

    if (image) {
      const file = join(outDir, `${item.id.replace(/[:@]/g, "_")}-dpr${dpr}.png`);
      const bytes = Buffer.from(await image.blob.arrayBuffer());
      writeFileSync(file, bytes);
      row.file = file;
      if (!item.noBlocks && !item.url) {
        const png = decodePng(bytes);
        const name = item.path.split("/")[2].split("?")[0];
        const query = new URL(item.path, "http://x").searchParams;
        const blocks = expected(name, query, { vh: before.vh, port });
        const score = scoreBlocks(png, blocks, png.width / row.cssWidth);
        row.blocks = `${score.ok}/${score.total}`;
        row.blocksFailed = score.failed;
        if (name === "sticky-fixed") {
          const s = png.width / row.cssWidth;
          const cols = (x, c) => colorBands(png, Math.floor(x * s), c).map(([a, b]) => `${Math.round(a / s)}–${Math.round(b / s)}`);
          row.fixedAndSticky = { rodapeFixo: cols(640, "#ff00ff"), sidebarSticky: cols(100, "#00ffff"), headerFixo: cols(640, "#222222").slice(0, 3) };
        }
      }
      if (item.id === "image") {
        const png = decodePng(bytes);
        const quads = ["#e61949", "#3cb44b", "#4363d8", "#f58231"].map(hexToRgb);
        const found = quads.map((c) => { for (let y = 0; y < png.height; y += 20) for (let x = 0; x < png.width; x += 20) if (close(pixelAt(png, x, y), c, 6)) return true; return false; });
        row.blocks = `${found.filter(Boolean).length}/4 cores`;
      }
    }
  } catch (error) {
    row.error = row.error ?? `harness: ${error.message}`;
  } finally {
    await closePage();
  }
  rows.push(row);
  const t = row.timings;
  console.log(`${id.padEnd(24)} ${row.error ? "ERRO " : "ok   "} ${String(row.pngWidth ?? "-")}x${row.pngHeight ?? "-"} ${row.effectiveScale ?? "-"}x ${row.strategy ?? "-"}${row.bands > 1 ? "(" + row.bands + ")" : ""}  ${row.megapixels ?? "-"}MP  ${row.bytes ? (row.bytes / 1e6).toFixed(1) + "MB" : "-"}  ${(row.elapsedMs / 1000).toFixed(1)}s  blocos=${row.blocks ?? "-"}  restaur=${row.restore ? (row.restore.identical ? "ok" : "dif" + row.restore.changed) : "-"} scroll=${row.scrollRestored ? "ok" : "NÃO"}${t ? `  [${Object.entries(t).map(([k, v]) => `${k.split(" ")[0]}:${v}`).join(" ")}]` : ""}${row.error ? "\n      → " + row.error.slice(0, 160) : ""}`);
  writeFileSync(join(outDir, "audit-results.json"), JSON.stringify(rows, null, 1));
}

try {
  for (const item of [...fixtures, ...(withReal ? real : [])]) {
    for (const dpr of item.dprs ?? [1, 2]) await run(item, dpr);
  }
} finally {
  browser.kill();
  server.close();
  setTimeout(() => process.exit(0), 500);
}
