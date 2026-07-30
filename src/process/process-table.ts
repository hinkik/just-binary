/**
 * ProcessTable models machine-level process state independently from a shell.
 *
 * Bash instances are intentionally cheap, throwaway shells. A process table is
 * kernel-like machine state, so callers may inject one table into many Bash
 * instances and keep jobs alive while the shell objects come and go.
 */

import { abortExitCode } from "../interpreter/errors.js";

export type JobSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

export interface JobInfo {
  pid: number;
  command: string;
  startedAt: number;
  state: "running" | "done";
  exitCode?: number;
}

export interface ListedJob extends JobInfo {
  jobNumber: number;
  marker: "+" | "-" | " ";
}

export interface ProcessTableOptions {
  /** Observer called for every chunk a job writes, so a host can log per-job. */
  onJobOutput?: (pid: number, fd: number, chunk: Uint8Array) => void;
  /** Called when a job settles (SIGCHLD). */
  onJobExit?: (pid: number, exitCode: number) => void;
  /** Maximum time disposal waits for aborted runners to settle. */
  disposeTimeoutMs?: number;
}

interface JobRecord {
  info: JobInfo;
  jobNumber: number;
  controller?: AbortController;
  promise?: Promise<number>;
}

export type JobRunner = (pid: number, signal: AbortSignal) => Promise<number>;

const FIRST_VIRTUAL_PID = 1000;
const MAX_REAPED_WAIT_STATUSES = 64;
const scheduleDisposalTimeout = globalThis.setTimeout.bind(globalThis);
const cancelDisposalTimeout = globalThis.clearTimeout.bind(globalThis);

export class ProcessTable {
  private readonly jobs = new Map<number, JobRecord>();
  private readonly reapedWaitStatuses = new Map<number, number>();
  private readonly options: ProcessTableOptions;
  private nextPid = FIRST_VIRTUAL_PID;
  private highestJobNumber = 0;
  private runningJobs = 0;
  private disposed = false;
  private disposePromise?: Promise<void>;

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
    const jobNumber = this.highestJobNumber + 1;
    const record: JobRecord = {
      info: {
        pid,
        command,
        startedAt: Date.now(),
        state: "running",
      },
      jobNumber,
      controller,
      promise: Promise.resolve(0),
    };
    this.jobs.set(pid, record);
    this.highestJobNumber = jobNumber;
    this.runningJobs++;

    record.promise = Promise.resolve()
      .then(() => runner(pid, controller.signal))
      .catch(() =>
        controller.signal.aborted ? abortExitCode(controller.signal.reason) : 1,
      )
      .then((exitCode) => {
        if (this.jobs.get(pid) === record) {
          this.runningJobs--;
        }
        record.info = {
          ...record.info,
          state: "done",
          exitCode,
        };
        // A completed-but-unreported job only needs its compact metadata.
        // Drop execution machinery while `jobs`/`wait` still have a row to reap.
        record.controller = undefined;
        record.promise = undefined;
        try {
          void Promise.resolve(this.options.onJobExit?.(pid, exitCode)).catch(
            () => {
              // Process settlement must not depend on an async host observer.
            },
          );
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

  /**
   * Snapshot jobs for the `jobs` builtin and reap every completed job included
   * in the snapshot. Markers are computed once for the complete table.
   */
  listJobs(selectedPids?: ReadonlySet<number>): ListedJob[] {
    const records = [...this.jobs.values()].sort(
      (a, b) => a.jobNumber - b.jobNumber,
    );
    const currentPid = records.at(-1)?.info.pid;
    const previousPid = records.at(-2)?.info.pid;
    const completedPids: number[] = [];
    const listed: ListedJob[] = [];

    for (const record of records) {
      if (selectedPids && !selectedPids.has(record.info.pid)) {
        continue;
      }
      listed.push({
        ...record.info,
        jobNumber: record.jobNumber,
        marker:
          record.info.pid === currentPid
            ? "+"
            : record.info.pid === previousPid
              ? "-"
              : " ",
      });
      if (record.info.state === "done") {
        completedPids.push(record.info.pid);
        this.rememberWaitStatus(record.info.pid, record.info.exitCode ?? 1);
      }
    }

    // TODO(job-termination-notice): the follow-up job-control work should emit
    // Bash's signal termination notice when a killed job is reaped here.
    this.deleteJobs(completedPids);
    return listed;
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
    record.controller?.abort(reason);
    return true;
  }

  async wait(pid?: number): Promise<number> {
    if (pid !== undefined) {
      const record = this.jobs.get(pid);
      if (!record) {
        return this.reapedWaitStatuses.get(pid) ?? 127;
      }
      const exitCode =
        record.info.state === "done"
          ? (record.info.exitCode ?? 1)
          : await (record.promise ?? Promise.resolve(1));
      if (this.jobs.get(pid) === record) {
        this.rememberWaitStatus(pid, exitCode);
        this.deleteJobs([pid]);
      }
      return exitCode;
    }

    const records = [...this.jobs.values()];
    const statusesToForget = new Set([
      ...this.reapedWaitStatuses.keys(),
      ...records.map((record) => record.info.pid),
    ]);
    if (records.length > 0) {
      await Promise.all(
        records.map(
          (record) =>
            record.promise ?? Promise.resolve(record.info.exitCode ?? 1),
        ),
      );
      this.deleteJobs(records.map((record) => record.info.pid));
    }
    for (const completedPid of statusesToForget) {
      this.reapedWaitStatuses.delete(completedPid);
    }
    return 0;
  }

  abortAll(reason: JobSignal = "SIGTERM"): void {
    for (const record of this.jobs.values()) {
      if (record.info.state === "running") {
        record.controller?.abort(reason);
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    const records = [...this.jobs.values()];
    let finishDisposal: () => void = () => undefined;
    this.disposePromise = new Promise<void>((resolve) => {
      finishDisposal = resolve;
    });
    this.abortAll("SIGKILL");
    this.jobs.clear();
    this.reapedWaitStatuses.clear();
    this.highestJobNumber = 0;
    this.runningJobs = 0;

    const timeout = scheduleDisposalTimeout(
      finishDisposal,
      this.options.disposeTimeoutMs ?? 1_000,
    );
    void Promise.allSettled(
      records.flatMap((record) => (record.promise ? [record.promise] : [])),
    ).then(() => {
      cancelDisposalTimeout(timeout);
      finishDisposal();
    });
    return this.disposePromise;
  }

  /** Number of jobs that currently count toward the concurrency limit. */
  get runningCount(): number {
    return this.runningJobs;
  }

  /** Bash job number assigned to a PID, or undefined for an unknown PID. */
  getJobNumber(pid: number): number | undefined {
    return this.jobs.get(pid)?.jobNumber;
  }

  /** Whether a PID is an active child or has a retained wait status. */
  canWait(pid: number): boolean {
    return this.jobs.has(pid) || this.reapedWaitStatuses.has(pid);
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
      void Promise.resolve(this.options.onJobOutput?.(pid, fd, chunk)).catch(
        () => {
          // Job execution and inherited delivery do not depend on an async observer.
        },
      );
    } catch {
      // Job execution and inherited delivery do not depend on an observer.
    }
  }

  private rememberWaitStatus(pid: number, exitCode: number): void {
    this.reapedWaitStatuses.delete(pid);
    this.reapedWaitStatuses.set(pid, exitCode);
    if (this.reapedWaitStatuses.size > MAX_REAPED_WAIT_STATUSES) {
      const oldestPid = this.reapedWaitStatuses.keys().next().value;
      if (oldestPid !== undefined) {
        this.reapedWaitStatuses.delete(oldestPid);
      }
    }
  }

  private deleteJobs(pids: Iterable<number>): void {
    let removedHighest = false;
    for (const pid of pids) {
      const record = this.jobs.get(pid);
      if (!record) {
        continue;
      }
      this.jobs.delete(pid);
      removedHighest ||= record.jobNumber === this.highestJobNumber;
    }
    if (!removedHighest) {
      return;
    }
    this.highestJobNumber = 0;
    for (const record of this.jobs.values()) {
      this.highestJobNumber = Math.max(this.highestJobNumber, record.jobNumber);
    }
  }
}
