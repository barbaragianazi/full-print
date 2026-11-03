// Corpus de sites reais (exige internet): v0.4.0 × v0.5.0, tempo, estratégia e regiões vazias.
// Inclui os sites que deram problema nos testes manuais da v0.4.0 (gsap.com, AOS Demo, Lenis): eles entram no corpus
// de QA mas NÃO são corrigidos nesta fase. A métrica "maiorFaixaUniforme" é uma pista de região vazia, não um veredito:
// sempre confirmar olhando o PNG salvo.
//
// Uso: node scripts/corpus-real.mjs <pasta-saida> [--sites=a,b] [--variants=v040,all]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_V040, DEFAULT_TUNING, capturePage } from "../src/background/capture.ts";
import { evalIn, launch, navigate, newPage, setDisplay } from "./lib/browser.mjs";
import { nodeDecodeStrip } from "./lib/node-decode.mjs";
import { decodePng } from "./lib/png.mjs";

const [outDir, ...flags] = process.argv.slice(2);
if (!outDir) { console.error("Uso: node scripts/corpus-real.mjs <pasta-saida> [--sites=…] [--variants=…]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const flag = (n) => flags.find((f) => f.startsWith(`--${n}=`))?.slice(n.length + 3);

const SITES = {
  example: "https://example.com/",
  wikipedia: "https://en.wikipedia.org/wiki/Web_browser",
  vue: "https://vuejs.org/",
  react: "https://react.dev/",
  gsap: "https://gsap.com/",
  aos: "https://michalsnik.github.io/aos/",
  lenis: "https://lenis.darkroom.engineering/",
  nexus: "https://lpnexus.vercel.app/",
};
const VARIANTS = { v040: BASELINE_V040, all: DEFAULT_TUNING };
const sites = flag("sites")?.split(",") ?? Object.keys(SITES);
const variants = flag("variants")?.split(",") ?? Object.keys(VARIANTS);

// maior sequência contínua de linhas de uma única cor (em px CSS), amostrando 9 colunas
function longestUniform(png, scale) {
  const cols = Array.from({ length: 9 }, (_, i) => Math.floor(((i + 0.5) / 9) * png.width));
  let best = 0, start = -1, bestAt = 0;
  for (let y = 0; y < png.height; y++) {
    const o0 = (y * png.width + cols[0]) * png.channels;
    const ref = [png.data[o0], png.data[o0 + 1], png.data[o0 + 2]];
    let uniform = true;
    for (const x of cols) {
      const o = (y * png.width + x) * png.channels;
      if (Math.abs(png.data[o] - ref[0]) > 3 || Math.abs(png.data[o + 1] - ref[1]) > 3 || Math.abs(png.data[o + 2] - ref[2]) > 3) { uniform = false; break; }
    }
    if (uniform) { if (start < 0) start = y; if (y - start + 1 > best) { best = y - start + 1; bestAt = start; } } else start = -1;
  }
  return { cssPx: Math.round(best / scale), aPartirDeCssPx: Math.round(bestAt / scale) };
}

const browser = await launch({ width: 1280, height: 800 });
const rows = [];
for (const site of sites) {
  for (const v of variants) {
    const page = await newPage(browser);
    await setDisplay(page.cdp, { width: 1280, height: 800, dpr: 1 });
    const row = { site, variante: v };
    try {
      await navigate(page.cdp, SITES[site], { settleMs: 4000, timeout: 45_000 });
      const entries = [];
      const push = (level) => (message, data) => entries.push({ level, message, data });
      const y0 = await evalIn(page.cdp, "scrollY", false);
      const t0 = Date.now();
      const image = await capturePage(page.cdp, { log: { info: push("info"), warn: push("warn"), error: push("error") }, report: () => {}, decodeStrip: nodeDecodeStrip, tuning: VARIANTS[v] });
      row.ms = Date.now() - t0;
      row.png = `${image.width}x${image.height}`;
      row.estrategia = `${image.strategy}(${image.bands})`;
      row.modo = image.mode;
      row.mb = +(image.blob.size / 1e6).toFixed(2);
      row.motivos = entries.find((e) => e.message === "Estratégia de captura")?.data?.motivos;
      row.tempos = entries.find((e) => e.message === "Tempos (ms)")?.data;
      const post = await evalIn(page.cdp, "({ y: scrollY, probe: typeof window.__fp })", false);
      row.restaurada = post.y === y0 && post.probe === "undefined";
      const buf = Buffer.from(await image.blob.arrayBuffer());
      writeFileSync(join(outDir, `${site}-${v}.png`), buf);
      row.faixaUniforme = longestUniform(decodePng(buf), image.effectiveScale);
    } catch (e) {
      row.erro = e instanceof Error ? e.message : String(e);
    }
    await page.close();
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
writeFileSync(join(outDir, "corpus-real.json"), JSON.stringify(rows, null, 1));
browser.kill();
setTimeout(() => process.exit(0), 300);
