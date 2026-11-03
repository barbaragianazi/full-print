// Contratos de mensagens entre o popup de progresso e o service worker.

export type CapturePhase =
  | "idle"
  | "preparing"
  | "scrolling"
  | "settling"
  | "capturing"
  | "restoring"
  | "saving"
  | "done"
  | "error";

export interface CaptureStatus {
  tabId: number;
  phase: CapturePhase;
  /** 0–100, nunca decresce durante uma captura. */
  progress: number;
  detail?: string;
  /** Mensagem amigável quando phase === "error". */
  error?: string;
  captureId?: string;
}

export type CaptureRequest =
  | { type: "capture:status"; tabId: number }
  | { type: "capture:start"; tabId: number } // inicia só se não houver captura para a aba
  | { type: "capture:retry"; tabId: number }
  | { type: "capture:logs"; tabId: number };

// service worker -> popup (broadcast; o popup pode estar fechado)
export interface CaptureProgressMessage {
  type: "capture:progress";
  status: CaptureStatus;
}

export function isCaptureRequest(msg: unknown): msg is CaptureRequest {
  if (typeof msg !== "object" || msg === null) return false;
  const { type, tabId } = msg as { type?: unknown; tabId?: unknown };
  return (
    typeof tabId === "number" &&
    (type === "capture:status" || type === "capture:start" || type === "capture:retry" || type === "capture:logs")
  );
}
