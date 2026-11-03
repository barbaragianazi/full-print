// Teste de fumaça da lógica CDP (preparação + captura) contra um Chrome real em modo headless.
// Usa os mesmos módulos da extensão (src/background/capture.ts), mas NÃO testa chrome.debugger,
// chrome.downloads, offscreen nem o popup — isso exige carregar a extensão manualmente.
//
// Uso: node scripts/cdp-smoke.mjs <url> <arquivo-saida.png> [larguraxaltura] [dpr] [scrollInicial]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePage } from "../src/background/capture.ts";
import { evaluate } from "../src/background/page-prep.ts";

const [url, out, size = "1280x800", dprArg = "1", startY = "120"] = process.argv.slice(2);
if (!url || !out) {
  console.error("Uso: node scripts/cdp-smoke.mjs <url> <saida.png> [LxA] [dpr]");
  process.exit(2);
}
const [vw, vh] = size.split("x").map(Number);
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "full-print-smoke-"));

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${vw},${vh}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitForTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome não iniciou");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((l) => l(msg));
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return {
    opened,
    close: () => ws.close(),
    on: (l) => listeners.push(l),
    send: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
  };
}

let exitCode = 0;
try {
  const target = await waitForTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.opened;

  await cdp.send("Page.enable");
  if (Number(dprArg) !== 1) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: vw, height: vh, deviceScaleFactor: Number(dprArg), mobile: false,
    });
  }
  const loaded = new Promise((resolve) =>
    cdp.on((m) => m.method === "Page.loadEventFired" && resolve()),
  );
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 30_000))]);
  await new Promise((r) => setTimeout(r, 1500));

  const probe = (expr) => evaluate(cdp, expr);
  const before = await probe("({ y: scrollY, h: document.documentElement.scrollHeight, w: innerWidth, vh: innerHeight, dpr: devicePixelRatio, title: document.title })");
  // Simula um usuário que estava no meio da página, para verificar a restauração.
  await probe(`window.scrollTo({ top: ${Number(startY)}, behavior: 'instant' })`);
  await new Promise((r) => setTimeout(r, 2500)); // deixa a página assentar na posição inicial
  const startScroll = await probe("scrollY");

  const t0 = Date.now();
  const log = { info: (m, d) => console.log("  INFO ", m, d ? JSON.stringify(d) : ""), warn: (m, d) => console.log("  WARN ", m, d ? JSON.stringify(d) : ""), error: (m, d) => console.log("  ERROR", m, d ? JSON.stringify(d) : "") };
  let lastPhase = "";
  const image = await capturePage(cdp, { log, report: (phase, progress, detail) => { if (phase !== lastPhase) { lastPhase = phase; console.log(`  [${phase} ${progress}%] ${detail ?? ""}`); } } });
  const elapsed = Date.now() - t0;

  const after = await probe("({ y: scrollY, probe: typeof window.__fp, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches })");
  const imageBytes = Buffer.from(await image.blob.arrayBuffer());
  writeFileSync(out, imageBytes);

  console.log(JSON.stringify({ url, title: before.title, viewport: `${before.w}x${before.vh}`, dpr: before.dpr, docHeightBefore: before.h, startScroll, png: `${image.width}x${image.height}`, bytes: imageBytes.length, strategy: image.strategy, bands: image.bands, effectiveScale: image.effectiveScale, elapsedMs: elapsed, scrollAfter: after.y, reducedMotionAfter: after.reduced, out }, null, 2));
  if (after.y !== startScroll) { console.error("FALHA: scroll não foi restaurado"); exitCode = 1; }
  if (after.reduced) { console.error("FALHA: reduced-motion ativo"); exitCode = 1; }
  if (after.probe !== "undefined") { console.error("FALHA: window.__fp não foi removido"); exitCode = 1; }
  cdp.close();
} catch (error) {
  console.error("ERRO:", error.message);
  exitCode = 1;
} finally {
  chrome.kill();
  setTimeout(() => process.exit(exitCode), 500);
}
