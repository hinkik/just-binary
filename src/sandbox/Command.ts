import type { Bash } from "../Bash.js";
import type { ExecResult } from "../types.js";
import { decode } from "../utils/bytes.js";

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
  private resultPromise: Promise<ExecResult>;

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

  private async execute(): Promise<ExecResult> {
    // Only pass options if they were explicitly provided (to avoid creating isolated state unnecessarily)
    const options =
      this.env || this.explicitCwd
        ? { cwd: this.explicitCwd ? this.cwd : undefined, env: this.env }
        : undefined;
    const result = await this.bashEnv.exec(this.cmdLine, options);
    this.exitCode = result.exitCode;
    return result;
  }

  async *logs(): AsyncGenerator<OutputMessage, void, unknown> {
    const result = await this.resultPromise;

    // For Bash, we don't have true streaming, so emit all at once
    if (result.stdout.length > 0) {
      yield {
        type: "stdout",
        data: decode(result.stdout),
        timestamp: new Date(),
      };
    }
    if (result.stderr.length > 0) {
      yield {
        type: "stderr",
        data: decode(result.stderr),
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
    return decode(result.stdout) + decode(result.stderr);
  }

  async stdout(): Promise<string> {
    const result = await this.resultPromise;
    return decode(result.stdout);
  }

  async stderr(): Promise<string> {
    const result = await this.resultPromise;
    return decode(result.stderr);
  }

  async kill(): Promise<void> {
    // For Bash synchronous execution, this is a no-op
    // Commands complete immediately in the simulation
  }
}

export interface CommandFinished extends Command {
  exitCode: number; // Guaranteed to be defined
}
