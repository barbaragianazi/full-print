// Camada fina sobre chrome.debugger. O resto do código só conhece a interface Cdp.

export interface Cdp {
  send<T = unknown>(method: string, params?: object): Promise<T>;
}

const PROTOCOL_VERSION = "1.3";

function describeAttachError(message: string): string {
  if (/another debugger/i.test(message)) {
    return "Outro depurador já está anexado a esta aba (outra extensão?). Feche-o e tente de novo.";
  }
  if (/cannot (access|attach)/i.test(message)) {
    return "O Chrome não permite depurar esta aba.";
  }
  return `Falha ao anexar o depurador: ${message}`;
}

// Cliente CDP sem ciclo de vida, para recuperar uma sessão órfã.
export function rawCdp(tabId: number): Cdp {
  return {
    send: async <T>(method: string, params?: object) =>
      (await chrome.debugger.sendCommand({ tabId }, method, params)) as T,
  };
}

// Sessão com ciclo de vida. Se o debugger for desanexado por fora (botão "Cancelar" da barra
// do Chrome, aba fechada, DevTools assumindo), todo comando pendente ou futuro rejeita.
export class DebuggerSession implements Cdp {
  readonly tabId: number;
  private attached = false;
  private readonly detachSignal: Promise<never>;
  private rejectDetach!: (error: Error) => void;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.detachSignal = new Promise<never>((_, reject) => {
      this.rejectDetach = reject;
    });
    this.detachSignal.catch(() => {}); // evita unhandled rejection quando ninguém está esperando
  }

  private readonly onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId !== this.tabId) return;
    this.attached = false;
    chrome.debugger.onDetach.removeListener(this.onDetach);
    const error = new Error(`O depurador foi desconectado da aba (${reason}). Captura cancelada.`);
    error.name = "DetachedError"; // não aciona o fallback de captura por faixas
    this.rejectDetach(error);
  };

  async attach(): Promise<void> {
    chrome.debugger.onDetach.addListener(this.onDetach);
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, PROTOCOL_VERSION);
      this.attached = true;
    } catch (error) {
      chrome.debugger.onDetach.removeListener(this.onDetach);
      throw new Error(describeAttachError(error instanceof Error ? error.message : String(error)));
    }
  }

  send<T = unknown>(method: string, params?: object): Promise<T> {
    const command = chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as Promise<T>;
    return Promise.race([command, this.detachSignal]);
  }

  // Nunca lança: é chamado em finally.
  async detach(): Promise<void> {
    chrome.debugger.onDetach.removeListener(this.onDetach);
    if (!this.attached) return;
    this.attached = false;
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // já desanexado
    }
  }
}
