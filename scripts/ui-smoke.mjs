// Teste de fumaça da UI (prévia e popup) em Chrome headless, servindo dist/ por HTTP local.
// A prévia roda "de verdade" (só usa IndexedDB). O popup roda com um STUB de chrome.* — isso
// valida a renderização e a lógica de estados, NÃO a integração real com o service worker.
//
// Uso: node scripts/ui-smoke.mjs <png-de-teste> <pasta-de-saida> <cssWidth> <cssHeight>
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const [pngPath, outDir, cssW, cssH] = process.argv.slice(2);
const dist = join(import.meta.dirname, "..", "dist");
const dl = join(outDir, "downloads");
mkdirSync(dl, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer((req, res) => {
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = readFileSync(join(dist, path));
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("nf");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const port = 9400 + Math.floor(Math.random() * 100);
const chrome = spawn(process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "fp-ui-"))}`,
  "--window-size=1280,800", "--no-first-run", "--disable-gpu", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (p, init) => (await fetch(`http://127.0.0.1:${port}${p}`, init)).json();
function connect(url) {
  const ws = new WebSocket(url); let id = 1; const pend = new Map(); const ls = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else ls.forEach((l) => l(m)); };
  return { ready: new Promise((r) => (ws.onopen = r)), on: (l) => ls.push(l), close: () => ws.close(),
    send: (method, params) => new Promise((res, rej) => { const i = id++; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }) };
}

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "OK   " : "FALHA"} ${name}${extra ? " — " + extra : ""}`); };
let exitCode = 0;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await json("/json/list")).find((t) => t.type === "page"); } catch {} }
  const browser = connect((await json("/json/version")).webSocketDebuggerUrl); await browser.ready;
  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl.replace(/\//g, "\\"), eventsEnabled: true });
  await browser.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });

  const page = connect(target.webSocketDebuggerUrl); await page.ready;
  const ev = async (expression, awaitPromise = true) => {
    const r = await page.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const goto = async (url) => { const loaded = new Promise((r) => page.on((m) => m.method === "Page.loadEventFired" && r())); await page.send("Page.navigate", { url }); await Promise.race([loaded, sleep(10000)]); await sleep(400); };
  const shot = async (name) => writeFileSync(join(outDir, name), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await page.send("Page.enable");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }); // headless: documento focado, como num clique real

  // ---------- PRÉVIA ----------
  await goto(`${origin}/preview/preview.html?id=nao-existe`);
  check("Prévia: captura inexistente mostra mensagem de expirada", (await ev("document.getElementById('message').textContent")).includes("expirou"));
  await goto(`${origin}/preview/preview.html`);
  check("Prévia: sem id mostra mensagem", (await ev("!document.getElementById('message').hidden")));

  const pngBytes = readFileSync(pngPath);
  const b64 = pngBytes.toString("base64");
  await ev(`(async () => {
    const bin = atob("${b64}"); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const db = await new Promise((res, rej) => { const r = indexedDB.open("full-print", 1); r.onupgradeneeded = () => r.result.createObjectStore("captures", { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction("captures", "readwrite"); tx.objectStore("captures").put({ id: "t1", createdAt: Date.now(), pageUrl: "https://lpnexus.vercel.app/", width: 0, height: 0, cssWidth: ${cssW}, cssHeight: ${cssH}, dpr: 1, blob: new Blob([bytes], { type: "image/png" }) }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close(); return true; })()`);
  await goto(`${origin}/preview/preview.html?id=t1`);
  const state = await ev(`({ w: document.getElementById('image').naturalWidth, h: document.getElementById('image').naturalHeight, meta: document.getElementById('meta').textContent, enabled: ['copy','save-png','save-pdf'].every(i => !document.getElementById(i).disabled), toolbarTop: document.getElementById('toolbar').getBoundingClientRect().top })`);
  check("Prévia: imagem carregada do IndexedDB", state.w > 0 && state.h > 0, `${state.w}x${state.h}; ${state.meta}`);
  check("Prévia: 3 botões habilitados", state.enabled);
  await shot("preview-top.png");
  await ev("window.scrollTo(0, 3000)", false); await sleep(200);
  check("Prévia: toolbar permanece no topo ao rolar (sticky)", (await ev("document.getElementById('toolbar').getBoundingClientRect().top")) === 0);

  await ev("document.getElementById('copy').click()", false); await sleep(800);
  const toastCopy = await ev("document.getElementById('toast').textContent");
  const clip = await ev(`(async () => { try { const items = await navigator.clipboard.read(); const t = items[0].types; const b = await items[0].getType("image/png"); const bmp = await createImageBitmap(b); return { types: t, width: bmp.width, height: bmp.height }; } catch (e) { return { error: String(e) }; } })()`);
  check("Prévia: Copiar imagem -> PNG com as mesmas dimensões na área de transferência (o Chrome recodifica, então o tamanho em bytes difere)", clip.width === pngBytes.readUInt32BE(16) && clip.height === pngBytes.readUInt32BE(20), `toast="${toastCopy}" ${JSON.stringify(clip)}`);

  await ev("document.getElementById('save-png').click()", false); await sleep(1500);
  await ev("document.getElementById('save-pdf').click()", false);
  for (let i = 0; i < 60 && !readdirSync(dl).some((f) => f.endsWith(".pdf")); i++) await sleep(500);
  await sleep(800);
  const files = readdirSync(dl);
  const pngFile = files.find((f) => f.endsWith(".png")), pdfFile = files.find((f) => f.endsWith(".pdf"));
  check("Prévia: Salvar PNG baixou arquivo com nome esperado", !!pngFile && /^full-print-lpnexus\.vercel\.app-\d{8}-\d{6}\.png$/.test(pngFile), pngFile);
  if (pngFile) check("Prévia: PNG baixado é idêntico ao capturado (SHA-256)", createHash("sha256").update(readFileSync(join(dl, pngFile))).digest("hex") === createHash("sha256").update(pngBytes).digest("hex"));
  check("Prévia: Salvar PDF baixou arquivo", !!pdfFile, pdfFile);
  if (pdfFile) {
    const pdf = readFileSync(join(dl, pdfFile));
    const text = pdf.toString("latin1");
    const pages = (text.match(/\/Type \/Page /g) || []).length;
    const media = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => `${m[1]}x${m[2]}`);
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    check("PDF: cabeçalho, %%EOF e xref no offset indicado", text.startsWith("%PDF-1.4") && text.trimEnd().endsWith("%%EOF") && text.slice(xrefAt, xrefAt + 4) === "xref", `${pdf.length} bytes`);
    check("PDF: páginas e MediaBox (1249×6792 px CSS = 936.75×5094 pt)", pages === 1 && media[0] === "936.75x5094.00", `páginas=${pages} mediabox=${media.join(",")}`);
    // Todos os offsets do xref apontam para "N 0 obj"
    const entries = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    check("PDF: todos os offsets do xref apontam para objetos", entries.length > 0 && entries.every((o, i) => text.slice(o).startsWith(`${i + 1} 0 obj`)), `${entries.length} objetos`);
  }
  console.log("PDF salvo em:", pdfFile ? join(dl, pdfFile) : "(nenhum)");

  // ---------- POPUP (com stub de chrome.*) ----------
  const stub = (status) => `
    window.__sent = []; window.__listeners = []; window.__status = ${JSON.stringify(status)};
    window.chrome = { runtime: { getManifest: () => ({ version: "0.3.0" }),
      onMessage: { addListener: (l) => window.__listeners.push(l) },
      sendMessage: async (m) => { window.__sent.push(m.type);
        if (m.type === "capture:status") return window.__status;
        if (m.type === "capture:logs") return "+0ms INFO Captura iniciada\\n+900ms ERROR Captura falhou";
        window.__status = { tabId: 7, phase: "preparing", progress: 1 }; return window.__status; } },
      tabs: { query: async () => [{ id: 7 }] } };`;
  const emit = (status) => ev(`window.__listeners.forEach((l) => l({ type: "capture:progress", status: ${JSON.stringify(status)} }))`, false);
  const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: stub({ tabId: 7, phase: "scrolling", progress: 45, detail: "Rolando a página (60%)" }) });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 300, height: 260, deviceScaleFactor: 2, mobile: false });
  await goto(`${origin}/popup/popup.html`);
  let ui = await ev(`({ phase: document.getElementById('phase').textContent, pct: document.getElementById('percent').textContent, now: document.getElementById('bar').getAttribute('aria-valuenow'), width: document.getElementById('fill').style.width, errHidden: document.getElementById('error').hidden })`);
  check("Popup: exibe progresso 45% com a etapa (sem percentual embutido)", ui.pct === "45%" && ui.now === "45" && ui.width === "45%" && ui.phase === "percorrendo a página" && ui.errHidden, JSON.stringify(ui));
  await shot("popup-progress.png");
  await emit({ tabId: 7, phase: "error", progress: 45, error: "Outro depurador já está anexado a esta aba (outra extensão?). Feche-o e tente de novo." }); await sleep(300);
  ui = await ev(`({ errHidden: document.getElementById('error').hidden, msg: document.getElementById('error-message').textContent, log: document.getElementById('log').textContent, retry: !document.getElementById('retry').disabled })`);
  check("Popup: erro mostra mensagem clara, log técnico e Tentar novamente", !ui.errHidden && ui.msg.includes("depurador") && ui.log.includes("ERROR") && ui.retry, JSON.stringify({ ...ui, log: ui.log.length + " chars" }));
  await shot("popup-error.png");
  await emit({ tabId: 99, phase: "done", progress: 100 }); await sleep(100);
  check("Popup: ignora progresso de outra aba", (await ev("document.getElementById('percent').textContent")) === "45%");
  await ev("document.getElementById('retry').click()", false); await sleep(400);
  ui = await ev(`({ sent: window.__sent.filter((t) => t !== 'capture:logs'), errHidden: document.getElementById('error').hidden, pct: document.getElementById('percent').textContent })`);
  check("Popup: Tentar novamente envia capture:retry e volta ao progresso", ui.sent.includes("capture:retry") && ui.errHidden, JSON.stringify(ui));
  await emit({ tabId: 7, phase: "done", progress: 100 }); await sleep(200);
  check("Popup: concluído mostra 100%", (await ev("document.getElementById('percent').textContent")) === "100%");
  await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  // popup aberto com worker sem captura (idle) -> inicia
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: stub({ tabId: 7, phase: "idle", progress: 0 }) });
  await goto(`${origin}/popup/popup.html`);
  check("Popup: status idle dispara capture:start", (await ev("window.__sent.includes('capture:start')")) === true);
} catch (e) {
  console.error("ERRO:", e.stack ?? e.message); results.push(false);
} finally {
  exitCode = results.every(Boolean) && results.length ? 0 : 1;
  console.log(`\n${results.filter(Boolean).length}/${results.length} verificações OK`);
  chrome.kill(); server.close(); setTimeout(() => process.exit(exitCode), 500);
}
