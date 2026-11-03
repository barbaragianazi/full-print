// Feedback no ícone da extensão: badge com percentual, título e popup de progresso por aba.
// O popup só é definido enquanto há algo a mostrar (captura ou erro); sem popup, o clique no
// ícone dispara chrome.action.onClicked.
import type { CaptureStatus } from "../shared/messages.ts";

const PROGRESS_POPUP = "popup/popup.html";
const BADGE_BUSY = "#2563eb";
const BADGE_ERROR = "#dc2626";

const ignore = () => {};

export function renderBadge(status: CaptureStatus): void {
  const { tabId, phase, progress } = status;
  if (phase === "error") {
    void chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_ERROR }).catch(ignore);
    void chrome.action.setBadgeText({ tabId, text: "!" }).catch(ignore);
    void chrome.action.setTitle({ tabId, title: "full-print: a captura falhou. Clique para ver o erro." }).catch(ignore);
  } else if (phase === "done" || phase === "idle") {
    void chrome.action.setBadgeText({ tabId, text: "" }).catch(ignore);
    void chrome.action.setTitle({ tabId, title: "full-print" }).catch(ignore);
  } else {
    void chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BUSY }).catch(ignore);
    void chrome.action.setBadgeText({ tabId, text: `${Math.round(progress)}%` }).catch(ignore);
    void chrome.action.setTitle({ tabId, title: `full-print: capturando ${Math.round(progress)}%` }).catch(ignore);
  }
}

export async function enableProgressPopup(tabId: number): Promise<void> {
  await chrome.action.setPopup({ tabId, popup: PROGRESS_POPUP }).catch(ignore);
}

export async function resetPopup(tabId: number): Promise<void> {
  await chrome.action.setPopup({ tabId, popup: "" }).catch(ignore);
}

// Abre o popup de progresso. Pode falhar (ex.: janela sem foco); a captura segue pelo badge.
export async function openProgressPopup(windowId?: number): Promise<void> {
  try {
    await chrome.action.openPopup(windowId === undefined ? undefined : { windowId });
  } catch {
    // sem popup: o usuário acompanha pelo badge
  }
}
