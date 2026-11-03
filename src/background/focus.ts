// Garante que a aba capturada esteja visível durante a captura (abas em segundo plano pausam
// requestAnimationFrame e degradam a fidelidade em silêncio — auditoria E8) e restaura o foco
// original ao terminar, inclusive em erro. Só mexe no que for necessário e só desfaz o que fez.
import type { Logger } from "./log.ts";

const ignore = () => {};

export class FocusGuard {
  private readonly tabId: number;
  private readonly log: Logger;
  private previousTabId: number | undefined;
  private previousFocusedWindowId: number | undefined;
  private previousWindowState: string | undefined; // "minimized" quando restauramos a janela
  private windowId: number | undefined;
  private touched = false;

  constructor(tabId: number, log: Logger) {
    this.tabId = tabId;
    this.log = log;
  }

  // Idempotente: pode ser chamado várias vezes (o usuário pode trocar de aba de novo).
  async ensureVisible(): Promise<void> {
    const tab = await chrome.tabs.get(this.tabId);
    this.windowId = tab.windowId;
    const win = await chrome.windows.get(tab.windowId);

    if ((win.state as string) === "minimized") {
      this.previousWindowState ??= "minimized";
      await chrome.windows.update(tab.windowId, { state: "normal" as chrome.windows.WindowState });
      this.touched = true;
      this.log.info("Janela restaurada da minimização");
    }
    if (!tab.active) {
      const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (active?.id !== undefined && active.id !== this.tabId) this.previousTabId ??= active.id;
      await chrome.tabs.update(this.tabId, { active: true });
      this.touched = true;
      this.log.info("Aba trazida à frente", { abaAnterior: this.previousTabId !== undefined });
    }
    if (!win.focused) {
      // Cobre janelas ocultas por outra janela (oclusão): só foca se o Chrome ainda a vê como não focada.
      const last = await chrome.windows.getLastFocused().catch(() => undefined);
      if (last?.id !== undefined && last.id !== tab.windowId) this.previousFocusedWindowId ??= last.id;
      await chrome.windows.update(tab.windowId, { focused: true });
      this.touched = true;
      this.log.info("Janela focada", { janelaAnterior: this.previousFocusedWindowId !== undefined });
    }
  }

  // Nunca lança: é chamado em finally. Desfaz na ordem inversa.
  async restore(): Promise<void> {
    if (!this.touched) return;
    try {
      if (this.previousTabId !== undefined && this.windowId !== undefined) {
        await chrome.tabs.update(this.previousTabId, { active: true }).catch(ignore);
      }
      if (this.previousFocusedWindowId !== undefined) {
        await chrome.windows.update(this.previousFocusedWindowId, { focused: true }).catch(ignore);
      }
      if (this.previousWindowState && this.windowId !== undefined) {
        await chrome.windows.update(this.windowId, { state: this.previousWindowState as chrome.windows.WindowState }).catch(ignore);
      }
      this.log.info("Foco original restaurado", {
        aba: this.previousTabId !== undefined,
        janela: this.previousFocusedWindowId !== undefined,
        estadoDaJanela: this.previousWindowState ?? null,
      });
    } catch {
      // melhor esforço
    }
    this.touched = false;
  }
}
