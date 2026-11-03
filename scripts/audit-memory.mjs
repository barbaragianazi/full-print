// Custo de processar PNGs grandes do lado da extensão (fora do CDP): base64 → Blob (mesmo código de
// src/background/blob.ts), IndexedDB (put/get), decodificação da <img>, createImageBitmap, Copiar
// imagem e geração de PDF. Usa PNGs sintéticos de ruído (pouco compressíveis = pior caso de tamanho
// de arquivo). NÃO mede o limite de mensagem do chrome.debugger nem a memória do service worker.
//
// Uso: node scripts/audit-memory.mjs [MP1,MP2,...]   (padrão 20,60,120)
import { createServer } from "node:http";
import { randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { connect, evalIn, launch, newPage, navigate } from "./lib/browser.mjs";

const sizesMp = (process.argv[2] ?? "20,60,120").split(",").map(Number);
const W = 2530;
const pdfJs = stripTypeScriptTypes(readFileSync(join(import.meta.dirname, "..", "src/preview/pdf.ts"), "utf8"));

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function noisePng(w, h) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  randomFillSync(raw);
  for (let i = 0; i < raw.length; i++) raw[i] &= 0xf0; // 4 bits de entropia por canal
  for (let y = 0; y < h; y++) raw[y * row] = 0; // filtro "None"
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

let current = Buffer.alloc(0);
const server = createServer((req, res) => {
  if (req.url === "/big.png") return res.writeHead(200, { "content-type": "image/png" }).end(current);
  if (req.url === "/pdf.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(pdfJs);
  res.writeHead(200, { "content-type": "text/html" }).end("<html><body></body></html>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch({ width: 1280, height: 800 });
const bws = connect((await browser.json("/json/version")).webSocketDebuggerUrl);
await bws.opened;
await bws.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });

const rows = [];
for (const mp of sizesMp) {
  const h = Math.round((mp * 1e6) / W);
  console.log(`\n--- gerando PNG de ruído ${W}x${h} (${mp} MP)…`);
  const t0 = Date.now();
  current = noisePng(W, h);
  console.log(`    ${(current.length / 1e6).toFixed(1)} MB em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const page = await newPage(browser);
  await page.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await navigate(page.cdp, `${origin}/`, { settleMs: 200 });
  const result = await evalIn(page.cdp, `(async () => {
    const T = {}, M = {}, E = {};
    const mem = () => Math.round(performance.memory.usedJSHeapSize / 1e6);
    const step = async (name, fn) => { const t = performance.now(); try { const v = await fn(); T[name] = Math.round(performance.now() - t); M[name] = mem(); return v; } catch (e) { E[name] = String(e && e.message || e).slice(0, 120); T[name] = Math.round(performance.now() - t); } };
    const buf = await step("fetch", async () => (await fetch("/big.png")).arrayBuffer());
    const b64 = await step("base64 (simula o CDP)", () => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.slice(fr.result.indexOf(",") + 1)); fr.readAsDataURL(new Blob([buf])); }));
    const blob = await step("base64ToBlob (blob.ts)", async () => {
      const parts = [], CH = 4 * 1024 * 1024;
      for (let s = 0; s < b64.length; s += CH) { const bin = atob(b64.slice(s, s + CH)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); parts.push(u); }
      return new Blob(parts, { type: "image/png" });
    });
    if (!blob) return { T, M, E, b64Mchars: Math.round(b64 ? b64.length / 1e6 : 0) };
    const db = await step("IndexedDB abrir", () => new Promise((res, rej) => { const r = indexedDB.open("mem-test", 1); r.onupgradeneeded = () => r.result.createObjectStore("c", { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    await step("IndexedDB put", () => new Promise((res, rej) => { const tx = db.transaction("c", "readwrite"); tx.objectStore("c").put({ id: 1, blob }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }));
    const back = await step("IndexedDB get", () => new Promise((res, rej) => { const tx = db.transaction("c"); const r = tx.objectStore("c").get(1); tx.oncomplete = () => res(r.result.blob); tx.onerror = () => rej(tx.error); }));
    await step("<img> decodificar", async () => { const img = new Image(); img.src = URL.createObjectURL(back); await img.decode(); return img.naturalWidth + "x" + img.naturalHeight; });
    await step("Copiar imagem (clipboard.write)", () => navigator.clipboard.write([new ClipboardItem({ "image/png": back })]));
    const { buildPdf } = await import("/pdf.js");
    const pdf = await step("Salvar PDF (buildPdf)", () => buildPdf({ blob: back, cssWidth: 1265, cssHeight: ${Math.round(h / 2)} }));
    return { T, M, E, pngMB: +(blob.size / 1e6).toFixed(1), b64Mchars: Math.round(b64.length / 1e6), pdfMB: pdf ? +(pdf.size / 1e6).toFixed(1) : null };
  })()`).catch((e) => ({ erroHarness: e.message.slice(0, 200) }));
  rows.push({ mp, png: `${W}x${h}`, ...result });
  console.log(JSON.stringify(rows.at(-1), null, 1));
  await page.close();
}
bws.close(); browser.kill(); server.close();
setTimeout(() => process.exit(0), 500);
