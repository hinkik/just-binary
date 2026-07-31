import type { JobSignal } from "../../process/process-table.js";
import type { ExecResult } from "../../types.js";
import { emptyStream, fromString } from "../../utils/stream.js";
import type { InterpreterContext } from "../types.js";

const KILL_USAGE =
  "kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n";

interface SignalDefinition {
  name: string;
  number: number;
  delivery: JobSignal;
}

const darwin = typeof process !== "undefined" && process.platform === "darwin";
// Virtual jobs have only running/done states. Terminating signals use the
// closest abort delivery channel plus their own signal number, preserving
// Bash's 128+n wait status. STOP and CONT are accepted no-ops because there is
// no stopped state to transition into or out of.
const SIGNAL_DEFINITIONS: SignalDefinition[] = [
  { name: "HUP", number: 1, delivery: "SIGTERM" },
  { name: "INT", number: 2, delivery: "SIGINT" },
  { name: "QUIT", number: 3, delivery: "SIGTERM" },
  { name: "KILL", number: 9, delivery: "SIGKILL" },
  { name: "TERM", number: 15, delivery: "SIGTERM" },
  { name: "USR1", number: darwin ? 30 : 10, delivery: "SIGTERM" },
  { name: "USR2", number: darwin ? 31 : 12, delivery: "SIGTERM" },
  { name: "STOP", number: darwin ? 17 : 19, delivery: "SIGSTOP" },
  { name: "CONT", number: darwin ? 19 : 18, delivery: "SIGCONT" },
];

function parseSignal(spec: string): SignalDefinition | undefined {
  const upper = spec.toUpperCase().replace(/^SIG/, "");
  if (/^\d+$/.test(upper)) {
    const number = Number.parseInt(upper, 10);
    return SIGNAL_DEFINITIONS.find((signal) => signal.number === number);
  }
  return SIGNAL_DEFINITIONS.find((signal) => signal.name === upper);
}

function invalidSignal(spec: string): ExecResult {
  return {
    stdout: emptyStream(),
    stderr: fromString(
      `bash: kill: ${spec.replace(/^-/, "")}: invalid signal specification\n`,
    ),
    exitCode: 1,
  };
}

function listSignals(specs: string[]): ExecResult {
  if (specs.length === 0) {
    return {
      stdout: fromString(
        `${SIGNAL_DEFINITIONS.map(
          (signal) => `${signal.number}) SIG${signal.name}`,
        ).join(" ")}\n`,
      ),
      stderr: emptyStream(),
      exitCode: 0,
    };
  }

  let stdout = "";
  for (const spec of specs) {
    const numeric = /^\d+$/.test(spec)
      ? String(Number.parseInt(spec, 10) - (Number(spec) > 128 ? 128 : 0))
      : spec;
    const signal = parseSignal(numeric);
    if (!signal) {
      return invalidSignal(spec);
    }
    stdout += /^\d+$/.test(spec) ? `${signal.name}\n` : `${signal.number}\n`;
  }
  return {
    stdout: fromString(stdout),
    stderr: emptyStream(),
    exitCode: 0,
  };
}

export function handleKill(
  ctx: InterpreterContext,
  args: string[],
): ExecResult {
  let signal = parseSignal("TERM") as SignalDefinition;
  let targetStart = 0;

  if (args[0] === "-l") {
    return listSignals(args.slice(1));
  }
  if (args[0] === "-s" || args[0] === "-n") {
    const signalSpec = args[1];
    if (!signalSpec) {
      return {
        stdout: emptyStream(),
        stderr: fromString(KILL_USAGE),
        exitCode: 2,
      };
    }
    const parsedSignal = parseSignal(signalSpec);
    if (!parsedSignal) {
      return invalidSignal(signalSpec);
    }
    signal = parsedSignal;
    targetStart = 2;
  } else if (args[0]?.startsWith("-") && args[0] !== "--") {
    const signalSpec = args[0].slice(1);
    const parsedSignal = parseSignal(signalSpec);
    if (!parsedSignal) {
      return invalidSignal(signalSpec);
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
    if (!ctx.processes.kill(pid, signal.delivery, signal.number)) {
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
