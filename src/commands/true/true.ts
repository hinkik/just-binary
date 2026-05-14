import type { Command, ExecResult } from "../../types.js";

export const trueCommand: Command = {
  name: "true",

  async execute(): Promise<ExecResult> {
    return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 0 };
  },
};

export const falseCommand: Command = {
  name: "false",

  async execute(): Promise<ExecResult> {
    return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 1 };
  },
};

import { emptyStream } from "../../utils/stream.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "true",
  flags: [],
};

export const falseFlagsForFuzzing: CommandFuzzInfo = {
  name: "false",
  flags: [],
};
