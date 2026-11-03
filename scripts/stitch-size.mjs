// Compara o tamanho do arquivo: PNG integral do Chrome × PNG costurado de faixas (png-stitch.ts), numa página real.
// Uso: node scripts/stitch-size.mjs <url> [alturaCssPorFaixa=4096]
import { stitchStrips } from "../src/background/png-stitch.ts";
import { launch, navigate, newPage, setDisplay, sleep } from "./lib/browser.mjs";
import { nodeDecodeStrip } from "./lib/node-decode.mjs";

const [url, bandArg = "4096"] = process.argv.slice(2);
const band = Number(bandArg);
const browser = await launch({ width: 1280, height: 800 });
const page = await newPage(browser);
await setDisplay(page.cdp, { width: 1280, height: 800, dpr: 1 });
await navigate(page.cdp, url, { settleMs: 4000 });
// rola a página para carregar conteúdo preguiçoso e volta ao topo
const height = await page.cdp.send("Runtime.evaluate", { expression: "document.documentElement.scrollHeight", returnByValue: true }).then((r) => r.result.value);
for (let y = 0; y < height; y += 600) { await page.cdp.send("Runtime.evaluate", { expression: `scrollTo({top:${y},behavior:'instant'})` }); await sleep(60); }
await page.cdp.send("Runtime.evaluate", { expression: "scrollTo({top:0,behavior:'instant'})" });
await sleep(1500);
const m = await page.cdp.send("Page.getLayoutMetrics");
const css = m.cssContentSize ?? m.contentSize;
const w = Math.ceil(css.width), h = Math.ceil(css.height);
const shot = (y, hh) => page.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width: w, height: hh, scale: 2 } }).then((r) => Buffer.from(r.data, "base64"));
const single = await shot(0, h);
const strips = [];
for (let y = 0; y < h; y += band) strips.push(new Blob([await shot(y, Math.min(band, h - y))], { type: "image/png" }));
const t0 = Date.now();
const stitched = await stitchStrips(strips, nodeDecodeStrip);
console.log(JSON.stringify({ url, css: `${w}x${h}`, png: `${stitched.width}x${stitched.height}`, faixas: strips.length, chromeIntegralMB: +(single.length / 1e6).toFixed(2), costuradoMB: +(stitched.blob.size / 1e6).toFixed(2), razao: +(stitched.blob.size / single.length).toFixed(2), somaDasFaixasMB: +(strips.reduce((s, b) => s + b.size, 0) / 1e6).toFixed(2), msCostura_Node: Date.now() - t0 }));
browser.kill();
setTimeout(() => process.exit(0), 300);
