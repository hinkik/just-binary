import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { toText } from "./test-utils.js";
import { decode } from "./utils/bytes.js";

describe("Bash.exec root collector error handling", () => {
  it("retains prior stdout and stderr when a deferred parse error is reached", async () => {
    let observedStdout = "";
    let observedStderr = "";
    const result = await toText(
      await new Bash().exec(
        "printf 'before-out\\n'; printf 'before-err\\n' >&2\n}",
        {
          stdoutSink: {
            write(chunk) {
              observedStdout += decode(chunk);
            },
          },
          stderrSink: {
            write(chunk) {
              observedStderr += decode(chunk);
            },
          },
        },
      ),
    );

    expect({
      observedStdout,
      observedStderr,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observedStdout: "before-out\n",
      observedStderr: "before-err\n",
      stdout: "before-out\n",
      stderr:
        "before-err\n" +
        "bash: syntax error: Parse error at 1:1: syntax error near unexpected token `}'\n",
      exitCode: 2,
    });
  });
});
