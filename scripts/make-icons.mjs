// Gera os ícones PNG da extensão (16/32/48/128) a partir de src/img/icon.png (arte oficial com fundo roxo, fornecida pelo design).
// O Chrome não aceita SVG em `icons` do manifesto; o PNG apenas é redimensionado (sem recolorir nem redesenhar).
// Uso: node scripts/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, navigate, newPage, setDisplay } from "./lib/browser.mjs";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, "src/img/icon.png"));
const out = join(root, "public/icons");
mkdirSync(out, { recursive: true });
const uri = `data:image/png;base64,${source.toString("base64")}`;
const browser = await launch({ width: 400, height: 400 });
const page = await newPage(browser);
for (const size of [16, 32, 48, 128]) {
  const html = `<!doctype html><body style="margin:0;background:transparent"><img src="${uri}" style="display:block;width:${size}px;height:${size}px;image-rendering:auto"></body>`;
  await setDisplay(page.cdp, { width: size, height: size, dpr: 1 });
  await navigate(page.cdp, `data:text/html;base64,${Buffer.from(html).toString("base64")}`, { settleMs: 300 });
  await page.cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const shot = await page.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size, height: size, scale: 1 }, fromSurface: true });
  writeFileSync(join(out, `icon-${size}.png`), Buffer.from(shot.data, "base64"));
  console.log(`icon-${size}.png`);
}
browser.kill();
setTimeout(() => process.exit(0), 300);
