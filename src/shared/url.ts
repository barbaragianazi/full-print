export type UrlCheck = { ok: true } | { ok: false; reason: string };

// Só http(s) pode ser capturado. A loja do Chrome bloqueia extensões e debugger.
export function validateCaptureUrl(url: string | undefined): UrlCheck {
  if (!url) {
    return { ok: false, reason: "Não foi possível ler a URL da aba ativa." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "URL da aba inválida." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Páginas ${parsed.protocol}// não podem ser capturadas. Abra uma página http(s).`,
    };
  }
  const isWebStore =
    parsed.hostname === "chromewebstore.google.com" ||
    (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"));
  if (isWebStore) {
    return { ok: false, reason: "A Chrome Web Store não permite captura por extensões." };
  }
  return { ok: true };
}

// Para logs e metadados: sem query string, hash ou credenciais (podem conter tokens).
export function redactUrl(url: string | undefined): string {
  if (!url) return "(sem url)";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(url inválida)";
  }
}

export function buildFilename(pageUrl: string, extension: "png" | "pdf", now = new Date()): string {
  let host = "pagina";
  try {
    host = new URL(pageUrl).hostname.replace(/[^a-z0-9.-]/gi, "-") || host;
  } catch {
    // mantém o nome genérico
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `full-print-${host}-${stamp}.${extension}`;
}
