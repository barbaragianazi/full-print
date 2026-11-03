// Log técnico de uma captura. Fica em memória e é exibido no popup de erro ("Copiar log").
// Regras: só metadados (contagens, tempos, versões, URL sem query/hash); nunca conteúdo da
// página, cookies, títulos ou campos de formulário.

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

interface LogEntry {
  t: number;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 300;

export class CaptureLog implements Logger {
  private readonly startedAt = Date.now();
  private readonly entries: LogEntry[] = [];

  private add(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.entries.length >= MAX_ENTRIES) this.entries.shift();
    this.entries.push({ t: Date.now() - this.startedAt, level, message, data });
    const line = `[full-print +${Date.now() - this.startedAt}ms] ${message}`;
    if (level === "error") console.error(line, data ?? "");
    else if (level === "warn") console.warn(line, data ?? "");
    else console.debug(line, data ?? "");
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.add("info", message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.add("warn", message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.add("error", message, data);
  }

  toText(): string {
    return this.entries
      .map((e) => {
        const data = e.data ? ` ${JSON.stringify(e.data)}` : "";
        return `+${String(e.t).padStart(6)}ms ${e.level.toUpperCase().padEnd(5)} ${e.message}${data}`;
      })
      .join("\n");
  }
}

// Cronômetro por fase: acumula milissegundos por rótulo. Só instrumentação, sem efeito no fluxo.
export class Stopwatch {
  private last = performance.now();
  private readonly laps: Record<string, number> = {};

  lap(label: string): void {
    const now = performance.now();
    this.laps[label] = (this.laps[label] ?? 0) + Math.round(now - this.last);
    this.last = now;
  }

  /** Descarta o intervalo desde a última marca. */
  skip(): void {
    this.last = performance.now();
  }

  snapshot(): Record<string, number> {
    return { ...this.laps, total: Object.values(this.laps).reduce((sum, ms) => sum + ms, 0) };
  }
}
