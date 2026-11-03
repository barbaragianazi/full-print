// Popup de progresso. Não controla a captura: apenas exibe o status do service worker e permite
// tentar novamente após um erro. Pode ser fechado a qualquer momento.
import type { CaptureProgressMessage, CaptureRequest, CaptureStatus } from "../shared/messages.ts";
import { initialViewState, toView } from "./progress-view.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const titleEl = $<HTMLHeadingElement>("title");
const phaseEl = $<HTMLParagraphElement>("phase");
const percentEl = $<HTMLParagraphElement>("percent");
const barEl = $<HTMLDivElement>("bar");
const fillEl = $<HTMLDivElement>("fill");
const errorEl = $<HTMLElement>("error");
const errorMessageEl = $<HTMLParagraphElement>("error-message");
const retryBtn = $<HTMLButtonElement>("retry");
const copyBtn = $<HTMLButtonElement>("copy-log");
const logEl = $<HTMLPreElement>("log");

let tabId: number | undefined;
const viewState = initialViewState();

function send<T>(request: CaptureRequest): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>;
}

async function showLog(): Promise<void> {
  if (tabId === undefined) return;
  try {
    logEl.textContent = (await send<string>({ type: "capture:logs", tabId })) || "(sem registros)";
  } catch {
    logEl.textContent = "(não foi possível ler o log)";
  }
}

function render(status: CaptureStatus): void {
  const isError = status.phase === "error";
  const view = toView(status, viewState);
  document.body.dataset.phase = status.phase;
  titleEl.textContent = view.title;
  phaseEl.textContent = view.phase;
  percentEl.textContent = `${view.percent}%`;
  fillEl.style.width = `${view.percent}%`;
  barEl.setAttribute("aria-valuenow", String(view.percent));
  barEl.setAttribute("aria-valuetext", `${view.percent}%, ${view.phase}`);
  errorEl.hidden = !isError;
  if (isError) {
    errorMessageEl.textContent = status.error ?? "Erro desconhecido.";
    retryBtn.disabled = false;
    copyBtn.textContent = "copiar log";
    void showLog();
  }
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const progress = message as CaptureProgressMessage | null;
  if (progress?.type === "capture:progress" && progress.status.tabId === tabId) render(progress.status);
});

retryBtn.addEventListener("click", async () => {
  if (tabId === undefined) return;
  retryBtn.disabled = true;
  try {
    render(await send<CaptureStatus>({ type: "capture:retry", tabId }));
  } catch (error) {
    errorMessageEl.textContent = error instanceof Error ? error.message : String(error);
    retryBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(logEl.textContent ?? "");
    copyBtn.textContent = "log copiado";
  } catch {
    copyBtn.textContent = "não foi possível copiar";
  }
});

void (async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (tabId === undefined) {
    render({ tabId: -1, phase: "error", progress: 0, error: "Nenhuma aba ativa encontrada." });
    retryBtn.disabled = true;
    return;
  }
  try {
    const status = await send<CaptureStatus>({ type: "capture:status", tabId });
    if (status.phase === "idle") {
      // Popup aberto sem captura (ex.: worker reiniciado): equivale a um novo clique no ícone.
      render(await send<CaptureStatus>({ type: "capture:start", tabId }));
    } else {
      render(status);
    }
  } catch {
    render({ tabId, phase: "error", progress: 0, error: "Não foi possível falar com a extensão." });
  }
})();
