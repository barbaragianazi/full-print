// Regras de exibição do progresso (sem DOM, testável em Node). Não calcula nem altera o progresso do motor:
// só decide o que mostrar. Textos de interface sempre em minúsculas.
import type { CapturePhase, CaptureStatus } from "../shared/messages.ts";

const PHASE_LABEL: Record<CapturePhase, string> = {
  idle: "iniciando…",
  preparing: "preparando conteúdo e animações",
  scrolling: "percorrendo a página",
  settling: "aguardando as animações",
  capturing: "capturando a imagem",
  restoring: "restaurando a página",
  saving: "salvando a captura",
  done: "abrindo a prévia",
  error: "a captura falhou",
};

const TITLE: Partial<Record<CapturePhase, string>> = {
  done: "captura concluída",
  error: "a captura falhou",
};

export interface ViewState {
  /** Maior percentual já exibido nesta captura. */
  shown: number;
  lastPhase: CapturePhase | null;
}

export interface View {
  title: string;
  phase: string;
  percent: number;
}

export const initialViewState = (): ViewState => ({ shown: 0, lastPhase: null });

// "capturando faixa 2 de 5" é a única mensagem detalhada do motor sem percentual embutido.
const BAND_DETAIL = /^Capturando faixa (\d+) de (\d+)$/;

export function toView(status: CaptureStatus, state: ViewState): View {
  // nova tentativa depois de erro/conclusão: recomeça do zero
  if (state.lastPhase === "error" || state.lastPhase === "done") state.shown = 0;
  state.lastPhase = status.phase;

  const raw = Math.max(0, Math.min(100, Math.round(status.progress)));
  // 100% só quando a captura está concluída e pronta para a prévia; nunca regride
  const capped = status.phase === "done" ? 100 : Math.min(raw, 99);
  state.shown = Math.max(state.shown, capped);

  const band = status.detail ? BAND_DETAIL.exec(status.detail) : null;
  const phase = band ? `capturando faixa ${band[1]} de ${band[2]}` : PHASE_LABEL[status.phase];
  return { title: TITLE[status.phase] ?? "captura em andamento...", phase, percent: state.shown };
}
