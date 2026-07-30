import type { JobSignal } from "../../process/process-table.js";
import type { ExecResult } from "../../types.js";
import { emptyStream, fromString } from "../../utils/stream.js";
import type { InterpreterContext } from "../types.js";

const KILL_USAGE =
  "kill: usage: kill [-TERM|-KILL|-INT|-15|-9|-2] pid | jobspec ...\n";

const SIGNALS = new Map<string, JobSignal>([
  ["TERM", "SIGTERM"],
  ["SIGTERM", "SIGTERM"],
  ["15", "SIGTERM"],
  ["KILL", "SIGKILL"],
  ["SIGKILL", "SIGKILL"],
  ["9", "SIGKILL"],
  ["INT", "SIGINT"],
  ["SIGINT", "SIGINT"],
  ["2", "SIGINT"],
]);

export function handleKill(
  ctx: InterpreterContext,
  args: string[],
): ExecResult {
  let signal: JobSignal = "SIGTERM";
  let targetStart = 0;

  if (args[0]?.startsWith("-") && args[0] !== "--") {
    const signalSpec = args[0].slice(1).toUpperCase();
    const parsedSignal = SIGNALS.get(signalSpec);
    if (!parsedSignal) {
      return {
        stdout: emptyStream(),
        stderr: fromString(
          `bash: kill: ${args[0]}: invalid signal specification\n`,
        ),
        exitCode: 2,
      };
    }
    signal = parsedSignal;
    targetStart = 1;
  } else if (args[0] === "--") {
    targetStart = 1;
  }

  const targets = args.slice(targetStart);
  if (targets.length === 0) {
    return {
      stdout: emptyStream(),
      stderr: fromString(KILL_USAGE),
      exitCode: 2,
    };
  }

  let stderr = "";
  let exitCode = 0;
  for (const target of targets) {
    let pid: number | undefined;
    if (target.startsWith("%")) {
      pid = ctx.processes.resolveJobSpec(target);
      if (pid === undefined) {
        stderr += `bash: kill: ${target}: no such job\n`;
        exitCode = 1;
        continue;
      }
    } else if (/^\d+$/.test(target)) {
      const parsed = Number(target);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        pid = parsed;
      }
    }

    if (pid === undefined) {
      stderr += `bash: kill: ${target}: arguments must be process or job IDs\n`;
      exitCode = 1;
      continue;
    }
    if (!ctx.processes.kill(pid, signal)) {
      stderr += `bash: kill: (${pid}) - No such process\n`;
      exitCode = 1;
    }
  }

  return {
    stdout: emptyStream(),
    stderr: fromString(stderr),
    exitCode,
  };
}
