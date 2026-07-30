import type { Bash, ExecOptions } from "../Bash.js";
import type { OutputSink } from "../interpreter/output-channels.js";
import { type JobSignal, ProcessTable } from "../process/process-table.js";
import { collectText } from "../utils/stream.js";

export interface OutputMessage {
  type: "stdout" | "stderr";
  data: string;
  timestamp: Date;
}

interface CommandResult {
  stdoutText: string;
  stderrText: string;
  exitCode: number;
}

export class Command {
  readonly cmdId: string;
  readonly cwd: string;
  /**
   * Bash-specific process ID. This is not part of the Vercel Sandbox API.
   */
  readonly pid: number;
  readonly startedAt: Date;
  exitCode: number | undefined;

  private bashEnv: Bash;
  private cmdLine: string;
  private env?: Record<string, string>;
  private explicitCwd: boolean;
  private processes: ProcessTable;
  private shellProcesses: ProcessTable;
  private logMessages: OutputMessage[] = [];
  private logReaders = new Set<() => void>();
  private logsComplete = false;
  private stdoutDecoder = new TextDecoder();
  private stderrDecoder = new TextDecoder();
  private resultPromise: Promise<CommandResult>;

  constructor(
    bashEnv: Bash,
    cmdLine: string,
    cwd: string,
    env?: Record<string, string>,
    explicitCwd = false,
    processes: ProcessTable = new ProcessTable(),
    shellProcesses: ProcessTable = bashEnv.processes,
  ) {
    this.cmdId = crypto.randomUUID();
    this.cwd = cwd;
    this.startedAt = new Date();
    this.bashEnv = bashEnv;
    this.processes = processes;
    this.shellProcesses = shellProcesses;
    this.cmdLine = cmdLine;
    this.env = env;
    this.explicitCwd = explicitCwd;

    let resolveResult: (result: CommandResult) => void = () => undefined;
    let rejectResult: (reason: unknown) => void = () => undefined;
    this.resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    // A Sandbox command is a process-table job in its own right. Sandbox keeps
    // this host-command table separate from Bash's shell-job table so `jobs`
    // and `wait` never see the enclosing Command itself.
    this.pid = processes.start(this.cmdLine, async (_pid, signal) => {
      try {
        const result = await this.execute(signal);
        resolveResult(result);
        return result.exitCode;
      } catch (error) {
        rejectResult(error);
        throw error;
      } finally {
        this.appendLog("stdout", this.stdoutDecoder.decode(), new Date());
        this.appendLog("stderr", this.stderrDecoder.decode(), new Date());
        this.logsComplete = true;
        const readers = [...this.logReaders];
        this.logReaders.clear();
        for (const reader of readers) {
          reader();
        }
      }
    });
    // Command.wait() waits on the public result object, so independently reap
    // the internal host-process record once its runner settles.
    void processes.wait(this.pid);
  }

  private appendLog(
    type: OutputMessage["type"],
    data: string,
    timestamp: Date,
  ): void {
    if (data.length === 0) {
      return;
    }
    this.logMessages.push({ type, data, timestamp });
    const readers = [...this.logReaders];
    this.logReaders.clear();
    for (const reader of readers) {
      reader();
    }
  }

  private async execute(signal: AbortSignal): Promise<CommandResult> {
    const stdoutSink: OutputSink = {
      write: (chunk) => {
        this.appendLog(
          "stdout",
          this.stdoutDecoder.decode(chunk, { stream: true }),
          new Date(),
        );
      },
    };
    const stderrSink: OutputSink = {
      write: (chunk) => {
        this.appendLog(
          "stderr",
          this.stderrDecoder.decode(chunk, { stream: true }),
          new Date(),
        );
      },
    };
    const options: ExecOptions = {
      cwd: this.explicitCwd ? this.cwd : undefined,
      env: this.env,
      processes: this.shellProcesses,
      signal,
      stdoutSink,
      stderrSink,
    };
    const result = await this.bashEnv.exec(this.cmdLine, options);
    this.exitCode = result.exitCode;
    const [stdoutText, stderrText] = await Promise.all([
      collectText(result.stdout),
      collectText(result.stderr),
    ]);
    return { stdoutText, stderrText, exitCode: result.exitCode };
  }

  async *logs(): AsyncGenerator<OutputMessage, void, unknown> {
    let index = 0;
    while (true) {
      while (index < this.logMessages.length) {
        yield this.logMessages[index++];
      }
      if (this.logsComplete) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.logReaders.add(resolve);
      });
    }
  }

  async wait(): Promise<CommandFinished> {
    await this.resultPromise;
    return this as CommandFinished;
  }

  async output(): Promise<string> {
    const result = await this.resultPromise;
    return result.stdoutText + result.stderrText;
  }

  async stdout(): Promise<string> {
    const result = await this.resultPromise;
    return result.stdoutText;
  }

  async stderr(): Promise<string> {
    const result = await this.resultPromise;
    return result.stderrText;
  }

  async kill(signal: JobSignal = "SIGTERM"): Promise<void> {
    this.processes.kill(this.pid, signal);
  }
}

export interface CommandFinished extends Command {
  exitCode: number; // Guaranteed to be defined
}
