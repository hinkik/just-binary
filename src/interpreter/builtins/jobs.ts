import type { ExecResult } from "../../types.js";
import { emptyStream, fromString } from "../../utils/stream.js";
import type { InterpreterContext } from "../types.js";

const JOBS_USAGE =
  "jobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]\n";

interface JobsOptions {
  long: boolean;
  pidsOnly: boolean;
  runningOnly: boolean;
  stoppedOnly: boolean;
  changedOnly: boolean;
}

type RunJobsCommand = (command: string, args: string[]) => Promise<ExecResult>;

function optionError(option: string): ExecResult {
  return {
    stdout: emptyStream(),
    stderr: fromString(`bash: jobs: ${option}: invalid option\n${JOBS_USAGE}`),
    exitCode: 2,
  };
}

export async function handleJobs(
  ctx: InterpreterContext,
  args: string[],
  runCommand?: RunJobsCommand,
): Promise<ExecResult> {
  if (args[0] === "-x") {
    const command = args[1];
    if (!command) {
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exitCode: 0,
      };
    }
    if (!runCommand) {
      return {
        stdout: emptyStream(),
        stderr: fromString("bash: jobs: -x: command execution unavailable\n"),
        exitCode: 1,
      };
    }
    const commandArgs: string[] = [];
    for (const arg of args.slice(2)) {
      if (!arg.startsWith("%")) {
        commandArgs.push(arg);
        continue;
      }
      // Bash substitutes the PIDs of specs it can resolve and passes anything
      // else through untouched: `jobs -x echo %99` prints `%99` and exits 0.
      const pid = ctx.processes.resolveJobSpec(arg);
      commandArgs.push(pid === undefined ? arg : String(pid));
    }
    return runCommand(command, commandArgs);
  }

  const options: JobsOptions = {
    long: false,
    pidsOnly: false,
    runningOnly: false,
    stoppedOnly: false,
    changedOnly: false,
  };
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      break;
    }
    for (const option of arg.slice(1)) {
      if (option === "l") options.long = true;
      else if (option === "n") options.changedOnly = true;
      else if (option === "p") options.pidsOnly = true;
      else if (option === "r") options.runningOnly = true;
      else if (option === "s") options.stoppedOnly = true;
      else return optionError(`-${option}`);
    }
  }

  const specs = args.slice(index);
  // A spec may still resolve to a job that has already been reaped, which keeps
  // `kill %1; wait %1` working. `jobs` does not report those: bash answers
  // `jobs %1` for a finished job with "no such job".
  const resolveLiveJob = (spec: string): number | undefined => {
    const pid = ctx.processes.resolveJobSpec(spec);
    return pid !== undefined && ctx.processes.get(pid) ? pid : undefined;
  };
  const selectedPids =
    specs.length === 0
      ? undefined
      : new Set(
          specs
            .map(resolveLiveJob)
            .filter((pid): pid is number => pid !== undefined),
        );
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (const spec of specs) {
    if (resolveLiveJob(spec) === undefined) {
      stderr += `bash: jobs: ${spec}: no such job\n`;
      exitCode = 1;
    }
  }

  const jobs = ctx.processes.listJobs(selectedPids, {
    changedOnly: options.changedOnly,
    runningOnly: options.runningOnly,
    stoppedOnly: options.stoppedOnly,
  });
  for (const job of jobs) {
    if (options.pidsOnly) {
      stdout += `${job.pid}\n`;
      continue;
    }
    const state =
      job.state === "running"
        ? "Running                 "
        : "Done                    ";
    const prefix = options.long
      ? `[${job.jobNumber}]${job.marker} ${job.pid} `
      : `[${job.jobNumber}]${job.marker}  `;
    stdout += `${prefix}${state}${job.command}\n`;
  }

  return {
    stdout: fromString(stdout),
    stderr: fromString(stderr),
    exitCode,
  };
}
