/**
 * ProcessTable models machine-level process state independently from a shell.
 *
 * Bash instances are intentionally cheap, throwaway shells. A process table is
 * kernel-like machine state, so callers may inject one table into many Bash
 * instances and keep jobs alive while the shell objects come and go.
 */

export type JobSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

export interface JobInfo {
  pid: number;
  command: string;
  startedAt: number;
  state: "running" | "done";
  exitCode?: number;
}

export interface ProcessTableOptions {
  /** Observer called for every chunk a job writes, so a host can log per-job. */
  onJobOutput?: (pid: number, fd: number, chunk: Uint8Array) => void;
  /** Called when a job settles (SIGCHLD). */
  onJobExit?: (pid: number, exitCode: number) => void;
}

interface JobRecord {
  info: JobInfo;
  jobNumber: number;
  controller: AbortController;
  promise: Promise<number>;
}

export type JobRunner = (pid: number, signal: AbortSignal) => Promise<number>;

const FIRST_VIRTUAL_PID = 1000;

function signalExitCode(reason: unknown): number {
  switch (reason) {
    case "SIGINT":
      return 130;
    case "SIGKILL":
      return 137;
    default:
      return 143;
  }
}

export class ProcessTable {
  private readonly jobs = new Map<number, JobRecord>();
  private readonly options: ProcessTableOptions;
  private nextPid = FIRST_VIRTUAL_PID;
  private nextJobNumber = 1;
  private limitVersion = 0;
  private disposed = false;

  constructor(options: ProcessTableOptions = {}) {
    this.options = options;
  }

  /**
   * Start a job and return its PID without awaiting it.
   *
   * The record is installed before the runner is invoked, so another shell
   * sharing this table can immediately inspect, kill, or wait for the job.
   */
  start(command: string, runner: JobRunner): number {
    if (this.disposed) {
      throw new Error("Cannot start a job on a disposed ProcessTable");
    }

    const pid = this.nextPid++;
    const controller = new AbortController();
    const record: JobRecord = {
      info: {
        pid,
        command,
        startedAt: Date.now(),
        state: "running",
      },
      jobNumber: this.nextJobNumber++,
      controller,
      promise: Promise.resolve(0),
    };
    this.jobs.set(pid, record);

    record.promise = Promise.resolve()
      .then(() => runner(pid, controller.signal))
      .catch(() =>
        controller.signal.aborted
          ? signalExitCode(controller.signal.reason)
          : 1,
      )
      .then((exitCode) => {
        record.info = {
          ...record.info,
          state: "done",
          exitCode,
        };
        try {
          this.options.onJobExit?.(pid, exitCode);
        } catch {
          // Process settlement must not depend on a host observer.
        }
        return exitCode;
      });

    return pid;
  }

  list(): JobInfo[] {
    return [...this.jobs.values()]
      .sort((a, b) => a.jobNumber - b.jobNumber)
      .map((record) => ({ ...record.info }));
  }

  get(pid: number): JobInfo | undefined {
    const info = this.jobs.get(pid)?.info;
    return info ? { ...info } : undefined;
  }

  kill(pid: number, reason: JobSignal): boolean {
    const record = this.jobs.get(pid);
    if (!record || record.info.state === "done") {
      return false;
    }
    record.controller.abort(reason);
    return true;
  }

  async wait(pid?: number): Promise<number> {
    if (pid !== undefined) {
      return (await this.jobs.get(pid)?.promise) ?? 127;
    }

    const jobs = [...this.jobs.values()];
    if (jobs.length === 0) {
      return 0;
    }
    await Promise.all(jobs.map((record) => record.promise));
    return 0;
  }

  abortAll(reason = "SIGTERM"): void {
    for (const record of this.jobs.values()) {
      if (record.info.state === "running") {
        record.controller.abort(reason);
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abortAll("SIGKILL");
    this.jobs.clear();
  }

  /** Number of jobs that currently count toward the concurrency limit. */
  get runningCount(): number {
    let count = 0;
    for (const record of this.jobs.values()) {
      if (record.info.state === "running") {
        count++;
      }
    }
    return count;
  }

  /** Bash job number assigned to a PID, or undefined for an unknown PID. */
  getJobNumber(pid: number): number | undefined {
    return this.jobs.get(pid)?.jobNumber;
  }

  /** Marker used by `jobs`: current job (+), previous job (-), or neither. */
  getJobMarker(pid: number): "+" | "-" | " " {
    const records = [...this.jobs.values()].sort(
      (a, b) => a.jobNumber - b.jobNumber,
    );
    const current = records.at(-1);
    const previous = records.at(-2);
    if (current?.info.pid === pid) {
      return "+";
    }
    if (previous?.info.pid === pid) {
      return "-";
    }
    return " ";
  }

  /** Resolve the numeric and current/previous job specs accepted by Bash. */
  resolveJobSpec(spec: string): number | undefined {
    const records = [...this.jobs.values()].sort(
      (a, b) => a.jobNumber - b.jobNumber,
    );
    if (spec === "%+" || spec === "%%") {
      return records.at(-1)?.info.pid;
    }
    if (spec === "%-") {
      return records.at(-2)?.info.pid;
    }
    const match = /^%(\d+)$/.exec(spec);
    if (!match) {
      return undefined;
    }
    const jobNumber = Number.parseInt(match[1], 10);
    return records.find((record) => record.jobNumber === jobNumber)?.info.pid;
  }

  /** Whether job channel wrappers need to report output to the host. */
  get observesOutput(): boolean {
    return this.options.onJobOutput !== undefined;
  }

  /** Report one output chunk. The table deliberately never retains it. */
  observeOutput(pid: number, fd: number, chunk: Uint8Array): void {
    try {
      this.options.onJobOutput?.(pid, fd, chunk);
    } catch {
      // Job execution and inherited delivery do not depend on an observer.
    }
  }

  /** Diagnostic invariant used by hosts/tests: output storage is host policy. */
  retainedOutputBytes(_pid: number): number {
    return 0;
  }

  /**
   * Monotonic safety event counter used by an owning shell to surface a
   * runaway background job before returning. Shared hosts can ignore it.
   */
  get executionLimitVersion(): number {
    return this.limitVersion;
  }

  reportExecutionLimit(): void {
    this.limitVersion++;
  }
}
