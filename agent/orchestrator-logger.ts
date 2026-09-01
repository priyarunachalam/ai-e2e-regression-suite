/**
 * Structured logging framework for the regression orchestration pipeline.
 *
 * Concepts:
 *  - PipelineId  — unique identifier for an orchestration run
 *  - Step        — one of the 7 numbered pipeline stages
 *  - LogEntry    — immutable structured record emitted per event
 *  - LogTransport — pluggable sink (console, file, or custom)
 *
 * Usage:
 *   const logger = new OrchestratorLogger([new ConsoleTransport()]);
 *   logger.enterStep("jira.read");
 *   logger.info("story.fetched", { issueKey: "ECOM-LOGIN-001" });
 *   const { durationMs } = logger.exitStep();
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export type OrchestratorStep =
  | "orchestrator"
  | "jira.read"
  | "test.generate"
  | "test.execute"
  | "result.capture"
  | "healing.trigger"
  | "test.rerun"
  | "jira.update";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  pipelineId: string;
  step: OrchestratorStep;
  event: string;
  durationMs?: number;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transport interface + implementations
// ---------------------------------------------------------------------------

export interface LogTransport {
  write(entry: LogEntry): void;
}

export class ConsoleTransport implements LogTransport {
  write(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === "error" || entry.level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

export class FileTransport implements LogTransport {
  private readonly stream: fs.WriteStream;

  constructor(logFile: string) {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.stream = fs.createWriteStream(logFile, { flags: "a", encoding: "utf8" });
  }

  write(entry: LogEntry): void {
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  close(): void {
    this.stream.end();
  }
}

/** Collects all entries in memory — useful for assertions in unit tests. */
export class BufferTransport implements LogTransport {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }

  filterByEvent(event: string): LogEntry[] {
    return this.entries.filter((e) => e.event === event);
  }

  filterByStep(step: OrchestratorStep): LogEntry[] {
    return this.entries.filter((e) => e.step === step);
  }

  filterByLevel(level: LogLevel): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  lastOf(event: string): LogEntry | undefined {
    return [...this.entries].reverse().find((e) => e.event === event);
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class OrchestratorLogger {
  readonly pipelineId: string;

  private currentStep: OrchestratorStep = "orchestrator";
  private stepStartMs: number = Date.now();
  private readonly minLevel: LogLevel;

  constructor(
    private readonly transports: LogTransport[],
    options: { pipelineId?: string; minLevel?: LogLevel } = {},
  ) {
    this.pipelineId = options.pipelineId ?? generatePipelineId();
    this.minLevel = options.minLevel ?? "info";
  }

  // -------------------------------------------------------------------------
  // Step lifecycle
  // -------------------------------------------------------------------------

  /** Mark the start of a pipeline step and begin timing. */
  enterStep(step: OrchestratorStep): void {
    this.currentStep = step;
    this.stepStartMs = Date.now();
    this.info(`${step}.started`);
  }

  /** Log step completion with elapsed duration and return timing info. */
  exitStep(): { step: OrchestratorStep; durationMs: number } {
    const durationMs = Date.now() - this.stepStartMs;
    this.info(`${this.currentStep}.completed`, undefined, durationMs);
    return { step: this.currentStep, durationMs };
  }

  // -------------------------------------------------------------------------
  // Log methods
  // -------------------------------------------------------------------------

  debug(event: string, context?: Record<string, unknown>, durationMs?: number): void {
    this.emit("debug", event, context, durationMs);
  }

  info(event: string, context?: Record<string, unknown>, durationMs?: number): void {
    this.emit("info", event, context, durationMs);
  }

  warn(event: string, context?: Record<string, unknown>, durationMs?: number): void {
    this.emit("warn", event, context, durationMs);
  }

  error(event: string, context?: Record<string, unknown>, durationMs?: number): void {
    this.emit("error", event, context, durationMs);
  }

  // -------------------------------------------------------------------------

  private emit(
    level: LogLevel,
    event: string,
    context?: Record<string, unknown>,
    durationMs?: number,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      pipelineId: this.pipelineId,
      step: this.currentStep,
      event,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(context !== undefined ? { context } : {}),
    };

    for (const transport of this.transports) {
      try {
        transport.write(entry);
      } catch {
        // Transport failures must not break the pipeline
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function generatePipelineId(): string {
  return `pl-${crypto.randomBytes(6).toString("hex")}`;
}
