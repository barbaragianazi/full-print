// Orquestração: uma captura por aba (duplicatas são ignoradas), independente do popup. Valida a
// aba, abre a sessão CDP, captura, desanexa (sempre), guarda o PNG no IndexedDB e abre a prévia.
import type { CaptureProgressMessage, CaptureStatus } from "../shared/messages.ts";
import { pruneCaptures, saveCapture } from "../shared/store.ts";
import { redactUrl, validateCaptureUrl } from "../shared/url.ts";
import { clearActive, markActive, recoverInterrupted } from "./active-capture.ts";
import { enableProgressPopup, openProgressPopup, renderBadge, resetPopup } from "./action-ui.ts";
import { capturePage, type CapturedImage } from "./capture.ts";
import { DebuggerSession } from "./cdp.ts";
import { FocusGuard } from "./focus.ts";
import { CaptureLog } from "./log.ts";

interface TabCapture {
  status: CaptureStatus;
  log: CaptureLog;
  running: boolean;
}

const captures = new Map<number, TabCapture>();

// Ao iniciar (inclusive após o worker ser encerrado no meio de uma captura), desfaz sessões órfãs.
const recovery = recoverInterrupted().catch(() => {});
void pruneCaptures();

// Chamar uma API de extensão periodicamente evita que o Chrome encerre o worker por inatividade.
let running = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;
function acquireKeepAlive(): void {
  if (++running === 1) keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
}
function releaseKeepAlive(): void {
  if (--running === 0) clearInterval(keepAlive);
}

function publish(entry: TabCapture, patch: Partial<CaptureStatus>): void {
  const progress = patch.progress === undefined ? entry.status.progress : Math.max(entry.status.progress, patch.progress);
  entry.status = { ...entry.status, ...patch, progress };
  renderBadge(entry.status);
  const message: CaptureProgressMessage = { type: "capture:progress", status: entry.status };
  // Sem popup aberto não há destinatário; o erro é esperado.
  chrome.runtime.sendMessage(message).catch(() => {});
}

export function getStatus(tabId: number): CaptureStatus {
  return captures.get(tabId)?.status ?? { tabId, phase: "idle", progress: 0 };
}

export function getLogs(tabId: number): string {
  return captures.get(tabId)?.log.toText() ?? "";
}

export function forgetTab(tabId: number): void {
  if (!captures.get(tabId)?.running) captures.delete(tabId);
}

async function captureTab(tabId: number, entry: TabCapture): Promise<CapturedImage> {
  const session = new DebuggerSession(tabId);
  const focus = new FocusGuard(tabId, entry.log);
  const attachStart = performance.now();
  await session.attach();
  entry.log.info("Debugger anexado", { ms: Math.round(performance.now() - attachStart) });
  try {
    return await capturePage(
      session,
      {
        log: entry.log,
        report: (phase, progress, detail) => publish(entry, { phase, progress, detail }),
        ensureVisible: () => focus.ensureVisible(),
      },
      (scroll) => markActive({ tabId, scroll, startedAt: Date.now() }),
    );
  } finally {
    // capturePage já restaurou a página; aqui só liberamos o debugger.
    await session.detach();
    await focus.restore(); // devolve o foco original (aba/janela), inclusive em erro
    await clearActive(tabId).catch(() => {});
  }
}

async function run(entry: TabCapture, tabId: number): Promise<void> {
  const { log } = entry;
  entry.running = true;
  const runStart = performance.now();
  acquireKeepAlive();
  let windowId: number | undefined;
  try {
    await recovery;
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
    log.info("Captura iniciada", {
      version: chrome.runtime.getManifest().version,
      url: redactUrl(tab.url),
    });
    const check = validateCaptureUrl(tab.url);
    if (!check.ok) throw new Error(check.reason);

    const image = await captureTab(tabId, entry);

    publish(entry, { phase: "saving", progress: 96, detail: "Salvando a captura" });
    const storeStart = performance.now();
    const blob = image.blob;
    const id = crypto.randomUUID();
    await saveCapture({
      id,
      createdAt: Date.now(),
      pageUrl: redactUrl(tab.url),
      width: image.width,
      height: image.height,
      cssWidth: image.cssWidth,
      cssHeight: image.cssHeight,
      dpr: image.dpr,
      blob,
    });
    void pruneCaptures();
    log.info("Captura salva", { id, bytes: blob.size, ms: Math.round(performance.now() - storeStart) });

    publish(entry, { phase: "done", progress: 100, detail: undefined, captureId: id });
    const openStart = performance.now();
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`preview/preview.html?id=${id}`),
      index: tab.index + 1,
      openerTabId: tabId,
      active: true,
    });
    log.info("Prévia aberta", { ms: Math.round(performance.now() - openStart), totalMs: Math.round(performance.now() - runStart) });
    await resetPopup(tabId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Captura encerrada com erro", { error: message });
    publish(entry, { phase: "error", detail: undefined, error: message });
    // O popup de erro (com "Tentar novamente") continua definido para esta aba.
    await openProgressPopup(windowId);
  } finally {
    entry.running = false;
    releaseKeepAlive();
  }
}

// Inicia a captura da aba, a menos que já exista uma em andamento para ela.
export async function startCapture(tabId: number): Promise<"started" | "already-running"> {
  if (captures.get(tabId)?.running) return "already-running";
  const entry: TabCapture = {
    status: { tabId, phase: "preparing", progress: 1, detail: "Iniciando" },
    log: new CaptureLog(),
    running: true, // reservado já aqui para que dois cliques seguidos não iniciem duas capturas
  };
  captures.set(tabId, entry);
  await enableProgressPopup(tabId);
  publish(entry, {});
  void run(entry, tabId);
  return "started";
}
