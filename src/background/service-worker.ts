// Service worker: um clique no ícone inicia a captura da aba ativa; o popup (opcional) só exibe
// o progresso e pode ser fechado sem afetar a captura.
import { isCaptureRequest } from "../shared/messages.ts";
import { openProgressPopup } from "./action-ui.ts";
import { forgetTab, getLogs, getStatus, startCapture } from "./capture-manager.ts";

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  await startCapture(tab.id); // se já houver captura para a aba, apenas mostra o progresso
  await openProgressPopup(tab.windowId);
});

chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isCaptureRequest(message)) return false;
  switch (message.type) {
    case "capture:status":
      sendResponse(getStatus(message.tabId));
      return false;
    case "capture:logs":
      sendResponse(getLogs(message.tabId));
      return false;
    case "capture:start":
    case "capture:retry":
      void startCapture(message.tabId).then(() => sendResponse(getStatus(message.tabId)));
      return true; // resposta assíncrona
  }
});
