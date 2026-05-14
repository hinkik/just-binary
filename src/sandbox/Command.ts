import type { Bash } from "../Bash.js";
import { collectText } from "../utils/stream.js";

export interface OutputMessage {
  type: "stdout" | "stderr";
  data: string;
  timestamp: Date;
}

export class Command {
  readonly cmdId: string;
  readonly cwd: string;
  readonly startedAt: Date;
  exitCode: number | undefined;

  private bashEnv: Bash;
  private cmdLine: string;
  private env?: Record<string, string>;
  private explicitCwd: boolean;
  private resultPromise: Promise<{
    stdoutText: string;
    stderrText: string;
    exitCode: number;
  }>;

  constructor(
    bashEnv: Bash,
    cmdLine: string,
    cwd: string,
    env?: Record<string, string>,
    explicitCwd = false,
  ) {
    this.cmdId = crypto.randomUUID();
    this.cwd = cwd;
    this.startedAt = new Date();
    this.bashEnv = bashEnv;
    this.cmdLine = cmdLine;
    this.env = env;
    this.explicitCwd = explicitCwd;

    // Start execution immediately
    this.resultPromise = this.execute();
  }

  private async execute(): Promise<{
    stdoutText: string;
    stderrText: string;
    exitCode: number;
  }> {
    // Only pass options if they were explicitly provided (to avoid creating isolated state unnecessarily)
    const options =
      this.env || this.explicitCwd
        ? { cwd: this.explicitCwd ? this.cwd : undefined, env: this.env }
        : undefined;
    const result = await this.bashEnv.exec(this.cmdLine, options);
    this.exitCode = result.exitCode;
    const [stdoutText, stderrText] = await Promise.all([
      collectText(result.stdout),
      collectText(result.stderr),
    ]);
    return { stdoutText, stderrText, exitCode: result.exitCode };
  }

  async *logs(): AsyncGenerator<OutputMessage, void, unknown> {
    const result = await this.resultPromise;

    // For Bash, we don't have true streaming, so emit all at once
    if (result.stdoutText.length > 0) {
      yield {
        type: "stdout",
        data: result.stdoutText,
        timestamp: new Date(),
      };
    }
    if (result.stderrText.length > 0) {
      yield {
        type: "stderr",
        data: result.stderrText,
        timestamp: new Date(),
      };
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

  async kill(): Promise<void> {
    // For Bash synchronous execution, this is a no-op
    // Commands complete immediately in the simulation
  }
}

export interface CommandFinished extends Command {
  exitCode: number; // Guaranteed to be defined
}
