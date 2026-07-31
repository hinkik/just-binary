import type { ExecResult } from "../../types.js";
import { emptyStream, fromString } from "../../utils/stream.js";
import { AbortExecutionError, checkAborted } from "../errors.js";
import type { InterpreterContext } from "../types.js";

const WAIT_USAGE = "wait: usage: wait [id ...]\n";

export async function handleWait(
  ctx: InterpreterContext,
  args: string[],
): Promise<ExecResult> {
  // `--` ends option parsing rather than being an option itself, so
  // `wait -- 999999` reports "not a child" like a bare id would.
  const endOfOptions = args.indexOf("--");
  const operands = endOfOptions === -1 ? args : args.slice(endOfOptions + 1);
  const optionArgs = endOfOptions === -1 ? args : args.slice(0, endOfOptions);
  const unsupportedOption = optionArgs.find((arg) => arg.startsWith("-"));
  if (unsupportedOption) {
    return {
      stdout: emptyStream(),
      stderr: fromString(
        `bash: wait: ${unsupportedOption}: invalid option\n${WAIT_USAGE}`,
      ),
      exitCode: 2,
    };
  }
  args = operands;

  checkAborted(ctx.signal);
  if (args.length === 0) {
    let onAbort: (() => void) | undefined;
    const abort = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AbortExecutionError(ctx.signal?.reason));
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const exitCode = await (ctx.signal
        ? Promise.race([ctx.processes.waitForLineage(ctx.lineageId), abort])
        : ctx.processes.waitForLineage(ctx.lineageId));
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exitCode,
      };
    } finally {
      if (onAbort) {
        ctx.signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  let exitCode = 0;
  let stderr = "";
  for (const target of args) {
    checkAborted(ctx.signal);
    const pid = target.startsWith("%")
      ? ctx.processes.resolveJobSpec(target)
      : /^\d+$/.test(target)
        ? Number(target)
        : undefined;
    if (
      pid === undefined ||
      !Number.isSafeInteger(pid) ||
      !ctx.processes.canWait(pid)
    ) {
      stderr += target.startsWith("%")
        ? `bash: wait: ${target}: no such job\n`
        : `bash: wait: pid ${target} is not a child of this shell\n`;
      exitCode = 127;
      continue;
    }

    let onAbort: (() => void) | undefined;
    const abort = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AbortExecutionError(ctx.signal?.reason));
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      exitCode = await (ctx.signal
        ? Promise.race([ctx.processes.wait(pid), abort])
        : ctx.processes.wait(pid));
    } finally {
      if (onAbort) {
        ctx.signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  return {
    stdout: emptyStream(),
    stderr: fromString(stderr),
    exitCode,
  };
}
