// Aba de prévia: mostra a captura (lida do IndexedDB) e só exporta quando o usuário pede.
import { loadCapture, type StoredCapture } from "../shared/store.ts";
import { REPO_URL } from "../shared/links.ts";
import { buildFilename } from "../shared/url.ts";
import { buildPdf } from "./pdf.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const metaEl = $<HTMLSpanElement>("meta");
const imageEl = $<HTMLImageElement>("image");
const messageEl = $<HTMLParagraphElement>("message");
const toastEl = $<HTMLParagraphElement>("toast");
const copyBtn = $<HTMLButtonElement>("copy");
const pngBtn = $<HTMLButtonElement>("save-png");
const pdfBtn = $<HTMLButtonElement>("save-pdf");
const githubLink = $<HTMLAnchorElement>("github");

const COPY_LABEL = "copiar imagem";
const FEEDBACK_MS = 2_000;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

if (REPO_URL) {
  githubLink.href = REPO_URL;
  githubLink.hidden = false;
}

// feedback no próprio botão: texto + cor discreta por ~2 s, depois volta ao original
function flashCopy(label: string, state: "success" | "error"): void {
  clearTimeout(copyTimer);
  copyBtn.textContent = label;
  copyBtn.dataset.state = state;
  copyTimer = setTimeout(() => {
    copyBtn.textContent = COPY_LABEL;
    delete copyBtn.dataset.state;
  }, FEEDBACK_MS);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function toast(text: string, kind: "info" | "error" = "info", persist = false): void {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.dataset.kind = kind;
  if (!persist) toastTimer = setTimeout(() => (toastEl.textContent = ""), 5_000);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function showFatal(text: string): void {
  metaEl.textContent = "";
  messageEl.textContent = text;
  messageEl.hidden = false;
}

function setup(capture: StoredCapture): void {
  const { blob, pageUrl } = capture;
  const imageUrl = URL.createObjectURL(blob);
  window.addEventListener("pagehide", () => URL.revokeObjectURL(imageUrl));
  imageEl.src = imageUrl;
  imageEl.hidden = false;
  const describe = (width: number, height: number) =>
    `${new URL(pageUrl).host} · ${width}×${height}px · ${formatBytes(blob.size)}`;
  metaEl.textContent = describe(capture.width, capture.height);
  // O tamanho real vem da imagem decodificada, não dos metadados.
  imageEl.addEventListener("load", () => (metaEl.textContent = describe(imageEl.naturalWidth, imageEl.naturalHeight)), { once: true });
  document.title = `full-print — ${new URL(pageUrl).host}`;
  copyBtn.disabled = pngBtn.disabled = pdfBtn.disabled = false;

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flashCopy("imagem copiada", "success");
    } catch (error) {
      flashCopy("erro ao copiar", "error");
      toast(`não foi possível copiar a imagem (${error instanceof Error ? error.message : error}). use salvar PNG.`, "error");
    }
  });

  pngBtn.addEventListener("click", () => {
    download(blob, buildFilename(pageUrl, "png"));
    toast("PNG salvo na pasta de downloads.");
  });

  pdfBtn.addEventListener("click", async () => {
    pdfBtn.disabled = true;
    try {
      toast("gerando PDF…", "info", true);
      const pdf = await buildPdf(capture, (fraction) => toast(`gerando PDF… ${Math.round(fraction * 100)}%`, "info", true));
      download(pdf, buildFilename(pageUrl, "pdf"));
      toast(`PDF salvo (${formatBytes(pdf.size)}).`);
    } catch (error) {
      toast(`falha ao gerar o PDF: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      pdfBtn.disabled = false;
    }
  });
}

void (async () => {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return showFatal("captura não informada. clique no ícone do full-print para capturar uma página.");
  try {
    const capture = await loadCapture(id);
    if (!capture) {
      return showFatal("esta captura expirou ou foi removida. volte à página e capture novamente.");
    }
    setup(capture);
  } catch (error) {
    showFatal(`não foi possível carregar a captura: ${error instanceof Error ? error.message : error}`);
  }
})();
