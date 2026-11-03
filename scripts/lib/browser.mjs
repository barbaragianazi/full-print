// Utilitários para controlar um Chrome headless via CDP (só para testes; fora da extensão).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((l) => l(msg));
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    opened,
    close: () => ws.close(),
    on: (l) => listeners.push(l),
    send: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
  };
}

export async function launch({ width = 1280, height = 800, extraArgs = [] } = {}) {
  const port = 9100 + Math.floor(Math.random() * 800);
  const proc = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "fp-audit-"))}`,
    `--window-size=${width},${height}`, "--no-first-run", "--disable-gpu", ...extraArgs, "about:blank",
  ], { stdio: "ignore" });
  const json = async (path, init) => (await fetch(`http://127.0.0.1:${port}${path}`, init)).json();
  let first;
  for (let i = 0; i < 60 && !first; i++) {
    await sleep(200);
    try { first = (await json("/json/list")).find((t) => t.type === "page"); } catch {}
  }
  if (!first) throw new Error("Chrome não iniciou");
  return { port, json, proc, first, kill: () => proc.kill() };
}

// Abre uma aba nova e devolve um cliente CDP já com Page habilitado.
export async function newPage(browser, url = "about:blank") {
  const target = await browser.json(`/json/new?${encodeURI(url)}`, { method: "PUT" });
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send("Page.enable");
  return { cdp, target, close: () => browser.json(`/json/close/${target.id}`).catch(() => {}) };
}

export async function navigate(cdp, url, { timeout = 30_000, settleMs = 1500 } = {}) {
  const loaded = new Promise((resolve) => cdp.on((m) => m.method === "Page.loadEventFired" && resolve()));
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(timeout)]);
  await sleep(settleMs);
}

export async function evalIn(cdp, expression, awaitPromise = true) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

export async function setDisplay(cdp, { width, height, dpr }) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
}
