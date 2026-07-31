/**
 * ProcessTable models machine-level process state independently from a shell.
 *
 * Bash instances are intentionally cheap, throwaway shells. A process table is
 * kernel-like machine state, so callers may inject one table into many Bash
 * instances and keep jobs alive while the shell objects come and go.
 */

import { abortExitCode } from "../interpreter/errors.js";

export type JobSignal =
  | "SIGTERM"
  | "SIGINT"
  | "SIGKILL"
  | "SIGSTOP"
  | "SIGCONT";

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
  lineageId?: number;
  controller?: AbortController;
  promise?: Promise<number>;
  changedStateReported?: JobInfo["state"];
}

interface ListJobsOptions {
  changedOnly?: boolean;
  runningOnly?: boolean;
  stoppedOnly?: boolean;
}

export type JobRunner = (pid: number, signal: AbortSignal) => Promise<number>;

const FIRST_VIRTUAL_PID = 1000;
/**
 * Completed jobs are reaped immediately, so only a compact wait status survives
 * per job. This caps how many, evicting least-recently-remembered first.
 *
 * Retention cannot be tied to the starting shell's lifetime: a table may be
 * shared, and the whole point of that is letting a job outlive the shell that
 * started it so another shell can still `wait` for it.
 *
 * Evicting a status makes `wait` report 127 where bash reports the real code, so
 * the cap sits far above realistic use — reaching it needs one table to retain
 * thousands of unwaited completed jobs. Real bash forgets old jobs too.
 */
const MAX_REAPED_WAIT_STATUSES = 4096;
const scheduleDisposalTimeout = globalThis.setTimeout.bind(globalThis);
const cancelDisposalTimeout = globalThis.clearTimeout.bind(globalThis);

export class ProcessTable {
  private readonly jobs = new Map<number, JobRecord>();
  private readonly reapedWaitStatuses = new Map<number, number>();
  private readonly reapedWaitLineages = new Map<number, number | undefined>();
  /**
   * Job numbers of reaped jobs, so `%n` still resolves right after the job dies.
   * Real bash reaps asynchronously, so `kill %1; wait %1` resolves `%1` while
   * `kill %1; sleep 0.3; wait %1` reports "no such job". We reap the instant the
   * runner settles, which would lose that idiom; keeping the number mapping
   * preserves it. Shares the wait-status lifecycle, so it is bounded the same way.
   */
  private readonly reapedJobNumbers = new Map<number, number>();
  private readonly options: ProcessTableOptions;
  private nextPid = FIRST_VIRTUAL_PID;
  private nextLineageId = 1;
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
  start(command: string, runner: JobRunner, lineageId?: number): number {
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
      lineageId,
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
        const installed = this.jobs.get(pid) === record;
        if (installed) {
          this.runningJobs--;
        }
        record.info = {
          ...record.info,
          state: "done",
          exitCode,
        };
        record.controller = undefined;
        record.promise = undefined;
        if (installed) {
          // A non-interactive bash reaps a completed child immediately: `jobs`
          // never lists it and `jobs %1` reports "no such job". Only the wait
          // status survives, so `wait <pid>` still reports it like bash does.
          // Dropping the record also keeps `jobs` markers and job-number
          // recycling computed over live jobs alone, as bash does.
          // TODO(job-termination-notice): bash prints a signal termination
          // notice ("Terminated: 15") when it reaps a killed job. Emitting it
          // needs a channel to write to, which the table deliberately lacks.
          this.rememberWaitStatus(
            pid,
            exitCode,
            record.lineageId,
            record.jobNumber,
          );
          this.deleteJobs([pid]);
        }
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
   * Snapshot jobs for the `jobs` builtin. Only live jobs are ever listed, since
   * completed ones are reaped as they settle — a non-interactive bash likewise
   * never lists a finished job. Markers are computed once for the whole table.
   */
  listJobs(
    selectedPids?: ReadonlySet<number>,
    options: ListJobsOptions = {},
  ): ListedJob[] {
    const records = [...this.jobs.values()].sort(
      (a, b) => a.jobNumber - b.jobNumber,
    );
    const currentPid = records.at(-1)?.info.pid;
    const previousPid = records.at(-2)?.info.pid;
    const listed: ListedJob[] = [];

    for (const record of records) {
      if (selectedPids && !selectedPids.has(record.info.pid)) {
        continue;
      }
      if (options.runningOnly && record.info.state !== "running") {
        continue;
      }
      // This process model has no stopped state, so `jobs -s` lists nothing.
      if (options.stoppedOnly) {
        continue;
      }
      if (
        options.changedOnly &&
        record.changedStateReported === record.info.state
      ) {
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
      if (options.changedOnly) {
        record.changedStateReported = record.info.state;
      }
    }

    return listed;
  }

  get(pid: number): JobInfo | undefined {
    const info = this.jobs.get(pid)?.info;
    return info ? { ...info } : undefined;
  }

  /**
   * Deliver one of the table's cooperative signals. A signal number preserves
   * 128+n for terminating signals mapped onto a supported delivery mode.
   * STOP/CONT are acknowledged no-ops because jobs have no stopped state.
   */
  kill(pid: number, reason: JobSignal, signalNumber?: number): boolean {
    const record = this.jobs.get(pid);
    if (!record || record.info.state === "done") {
      return false;
    }
    if (reason !== "SIGSTOP" && reason !== "SIGCONT") {
      record.controller?.abort(signalNumber ?? reason);
    }
    return true;
  }

  /**
   * Wait for machine-level process state. With no PID this intentionally drains
   * every job in the table; shell builtins must use waitForLineage instead.
   */
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
        this.rememberWaitStatus(pid, exitCode, record.lineageId);
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
      this.forgetWaitStatus(completedPid);
    }
    return 0;
  }

  /** Wait for and reap only jobs launched by one shell's own execution. */
  async waitForLineage(lineageId: number): Promise<number> {
    const waitedPids = new Set<number>();
    // Awaiting yields, so rescan instead of trusting one snapshot: a member of
    // this lineage may register another before the batch settles.
    for (;;) {
      const records = [...this.jobs.values()].filter(
        (record) => record.lineageId === lineageId,
      );
      if (records.length === 0) {
        break;
      }
      await Promise.all(
        records.map(
          (record) =>
            record.promise ?? Promise.resolve(record.info.exitCode ?? 1),
        ),
      );
      for (const record of records) {
        waitedPids.add(record.info.pid);
      }
      this.deleteJobs(records.map((record) => record.info.pid));
    }
    for (const [pid, reapedLineage] of this.reapedWaitLineages) {
      if (reapedLineage === lineageId) {
        waitedPids.add(pid);
      }
    }
    for (const pid of waitedPids) {
      this.forgetWaitStatus(pid);
    }
    return 0;
  }

  /** Allocate an identity shared by one shell's own in-process execution. */
  createLineageId(): number {
    return this.nextLineageId++;
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
    this.reapedWaitLineages.clear();
    this.reapedJobNumbers.clear();
    this.highestJobNumber = 0;
    this.runningJobs = 0;

    const timeout = scheduleDisposalTimeout(
      finishDisposal,
      this.options.disposeTimeoutMs ?? 1_000,
    );
    // Do not hold the event loop open just to wait out an uncooperative runner:
    // disposal is a deadline, not work the process should stay alive for.
    (timeout as { unref?: () => void }).unref?.();
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
      // Bash falls back to the current job when there is no previous one.
      return (records.at(-2) ?? records.at(-1))?.info.pid;
    }
    const match = /^%(\d+)$/.exec(spec);
    if (!match) {
      return undefined;
    }
    const jobNumber = Number.parseInt(match[1], 10);
    return (
      records.find((record) => record.jobNumber === jobNumber)?.info.pid ??
      this.reapedJobNumbers.get(jobNumber)
    );
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

  private rememberWaitStatus(
    pid: number,
    exitCode: number,
    lineageId?: number,
    jobNumber?: number,
  ): void {
    this.forgetWaitStatus(pid);
    // Re-inserting makes Map order recency order, so eviction drops the
    // least-recently-remembered status first.
    this.reapedWaitStatuses.set(pid, exitCode);
    this.reapedWaitLineages.set(pid, lineageId);
    if (jobNumber !== undefined) {
      this.reapedJobNumbers.set(jobNumber, pid);
    }
    if (this.reapedWaitStatuses.size > MAX_REAPED_WAIT_STATUSES) {
      const oldestPid = this.reapedWaitStatuses.keys().next().value;
      if (oldestPid !== undefined) {
        this.forgetWaitStatus(oldestPid);
      }
    }
  }

  private forgetWaitStatus(pid: number): void {
    this.reapedWaitStatuses.delete(pid);
    this.reapedWaitLineages.delete(pid);
    for (const [jobNumber, reapedPid] of this.reapedJobNumbers) {
      if (reapedPid === pid) {
        this.reapedJobNumbers.delete(jobNumber);
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
