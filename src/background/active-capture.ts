// Registro das capturas em andamento em chrome.storage.session (uma chave por aba). Se o service
// worker for encerrado no meio de uma captura, a sessão do debugger continua anexada à aba; na
// próxima inicialização estes registros permitem religar triggers congelados, restaurar o scroll
// e desanexar (melhor esforço: o caminho completo de restauração só roda com o worker vivo).
import { rawCdp } from "./cdp.ts";
import { scrollTo, type ScrollPosition } from "./page-prep.ts";

const PREFIX = "activeCapture:";

export interface ActiveCapture {
  tabId: number;
  scroll: ScrollPosition | null;
  startedAt: number;
}

export async function markActive(record: ActiveCapture): Promise<void> {
  await chrome.storage.session.set({ [PREFIX + record.tabId]: record });
}

export async function clearActive(tabId: number): Promise<void> {
  await chrome.storage.session.remove(PREFIX + tabId);
}

export async function recoverInterrupted(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(PREFIX)) continue;
    const record = value as ActiveCapture;
    const cdp = rawCdp(record.tabId);
    try {
      await cdp.send("Runtime.evaluate", { expression: "window.__fp && window.__fp.cleanup()" });
      if (record.scroll) await scrollTo(cdp, record.scroll);
    } catch {
      // não estava mais anexado, ou a aba foi fechada/navegada
    }
    try {
      await chrome.debugger.detach({ tabId: record.tabId });
    } catch {
      // já desanexado
    }
    await clearActive(record.tabId);
  }
}
