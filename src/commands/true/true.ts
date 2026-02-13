import type { Command, ExecResult } from "../../types.js";
import { EMPTY } from "../../utils/bytes.js";

export const trueCommand: Command = {
  name: "true",

  async execute(): Promise<ExecResult> {
    return { stdout: EMPTY, stderr: EMPTY, exitCode: 0 };
  },
};

export const falseCommand: Command = {
  name: "false",

  async execute(): Promise<ExecResult> {
    return { stdout: EMPTY, stderr: EMPTY, exitCode: 1 };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "true",
  flags: [],
};

export const falseFlagsForFuzzing: CommandFuzzInfo = {
  name: "false",
  flags: [],
};
