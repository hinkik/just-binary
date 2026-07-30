import type { ExecResult } from "../../types.js";
import { emptyStream, fromString } from "../../utils/stream.js";
import type { InterpreterContext } from "../types.js";

const JOBS_USAGE = "jobs: usage: jobs [jobspec ...]\n";

export function handleJobs(
  ctx: InterpreterContext,
  args: string[],
): ExecResult {
  const unsupportedOption = args.find(
    (arg) => arg.startsWith("-") && arg !== "--",
  );
  if (unsupportedOption) {
    return {
      stdout: emptyStream(),
      stderr: fromString(
        `bash: jobs: ${unsupportedOption}: invalid option\n${JOBS_USAGE}`,
      ),
      exitCode: 2,
    };
  }

  const specs = args.filter((arg) => arg !== "--");
  const selectedPids =
    specs.length === 0
      ? undefined
      : new Set(
          specs
            .map((spec) => ctx.processes.resolveJobSpec(spec))
            .filter((pid): pid is number => pid !== undefined),
        );
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (const spec of specs) {
    if (ctx.processes.resolveJobSpec(spec) === undefined) {
      stderr += `bash: jobs: ${spec}: no such job\n`;
      exitCode = 1;
    }
  }

  for (const job of ctx.processes.listJobs(selectedPids)) {
    const state =
      job.state === "running"
        ? "Running                 "
        : "Done                    ";
    stdout += `[${job.jobNumber}]${job.marker}  ${state}${job.command}\n`;
  }

  return {
    stdout: fromString(stdout),
    stderr: fromString(stderr),
    exitCode,
  };
}
