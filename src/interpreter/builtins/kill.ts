import type { JobSignal } from "../../process/process-table.js";
import type { ExecResult } from "../../types.js";
import { emptyStream, fromString } from "../../utils/stream.js";
import type { InterpreterContext } from "../types.js";

const KILL_USAGE =
  "kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n";

interface SignalDefinition {
  name: string;
  number: number;
  /** Absent when the signal's default action does not end the process. */
  delivery?: JobSignal;
}

const darwin = typeof process !== "undefined" && process.platform === "darwin";

/**
 * Signal names in platform order, matching what `kill -l` prints. Virtual jobs
 * have only running/done states, so a terminating signal is delivered through
 * the closest abort channel while carrying its own number, which preserves
 * bash's 128+n wait status. Signals whose default action is to stop, continue,
 * or be ignored are accepted no-ops: there is no stopped state to move into, and
 * `kill -WINCH` must not end a job.
 */
const SIGNAL_NAMES: readonly string[] = darwin
  ? // prettier-ignore
    [
      "HUP",
      "INT",
      "QUIT",
      "ILL",
      "TRAP",
      "ABRT",
      "EMT",
      "FPE",
      "KILL",
      "BUS",
      "SEGV",
      "SYS",
      "PIPE",
      "ALRM",
      "TERM",
      "URG",
      "STOP",
      "TSTP",
      "CONT",
      "CHLD",
      "TTIN",
      "TTOU",
      "IO",
      "XCPU",
      "XFSZ",
      "VTALRM",
      "PROF",
      "WINCH",
      "INFO",
      "USR1",
      "USR2",
    ]
  : // prettier-ignore
    [
      "HUP",
      "INT",
      "QUIT",
      "ILL",
      "TRAP",
      "ABRT",
      "BUS",
      "FPE",
      "KILL",
      "USR1",
      "SEGV",
      "USR2",
      "PIPE",
      "ALRM",
      "TERM",
      "STKFLT",
      "CHLD",
      "CONT",
      "STOP",
      "TSTP",
      "TTIN",
      "TTOU",
      "URG",
      "XCPU",
      "XFSZ",
      "VTALRM",
      "PROF",
      "WINCH",
      "IO",
      "PWR",
      "SYS",
    ];

/** Signals that do not terminate: stop/continue plus the ignored-by-default. */
const NON_TERMINATING = new Set([
  "STOP",
  "TSTP",
  "TTIN",
  "TTOU",
  "CONT",
  "CHLD",
  "URG",
  "WINCH",
  "INFO",
]);

function deliveryFor(name: string): JobSignal | undefined {
  if (NON_TERMINATING.has(name)) {
    return undefined;
  }
  if (name === "KILL") return "SIGKILL";
  if (name === "INT") return "SIGINT";
  return "SIGTERM";
}

const SIGNAL_DEFINITIONS: SignalDefinition[] = SIGNAL_NAMES.map(
  (name, index) => ({
    name,
    number: index + 1,
    delivery: deliveryFor(name),
  }),
);

/** Signal 0 sends nothing; it only probes whether the target exists. */
const EXISTENCE_PROBE: SignalDefinition = { name: "0", number: 0 };

function parseSignal(spec: string): SignalDefinition | undefined {
  const upper = spec.toUpperCase().replace(/^SIG/, "");
  if (/^\d+$/.test(upper)) {
    const number = Number.parseInt(upper, 10);
    if (number === 0) {
      return EXISTENCE_PROBE;
    }
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
    // Bash lays the table out four per line, tab separated, with the number
    // right-aligned in two columns, and ends the final row with a tab.
    let stdout = "";
    for (const signal of SIGNAL_DEFINITIONS) {
      stdout += `${String(signal.number).padStart(2)}) SIG${signal.name}\t`;
      if (signal.number % 4 === 0) {
        stdout = `${stdout.slice(0, -1)}\n`;
      }
    }
    return {
      stdout: fromString(stdout.endsWith("\n") ? stdout : `${stdout}\n`),
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
      exitCode: 1,
    };
  }

  let stderr = "";
  // Bash succeeds when it signalled at least one target, still reporting the
  // ones it could not: `kill $live 999999` exits 0, `kill 999998 999999` exits 1.
  let signalled = 0;
  let failed = 0;
  for (const target of targets) {
    let pid: number | undefined;
    if (target.startsWith("%")) {
      pid = ctx.processes.resolveJobSpec(target);
      if (pid === undefined) {
        stderr += `bash: kill: ${target}: no such job\n`;
        failed++;
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
      failed++;
      continue;
    }

    // Signal 0 only asks whether the target exists.
    const delivered =
      signal.number === 0
        ? ctx.processes.get(pid) !== undefined
        : signal.delivery === undefined
          ? ctx.processes.get(pid) !== undefined
          : ctx.processes.kill(pid, signal.delivery, signal.number);
    if (delivered) {
      signalled++;
    } else {
      stderr += `bash: kill: (${pid}) - No such process\n`;
      failed++;
    }
  }

  return {
    stdout: emptyStream(),
    stderr: fromString(stderr),
    exitCode: signalled > 0 || failed === 0 ? 0 : 1,
  };
}
