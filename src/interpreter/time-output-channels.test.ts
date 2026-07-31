import { describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { toText } from "../test-utils.js";

describe("time output channels", () => {
  it("writes deterministic default timing output to stderr", async () => {
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_500);

    try {
      const result = await toText(await new Bash().exec("time echo timed"));

      expect({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }).toEqual({
        stdout: "timed\n",
        stderr: "\nreal\t0m1.500s\nuser\t0m0.000s\nsys\t0m0.000s\n",
        exitCode: 0,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("keeps POSIX timing output outside command-local stderr redirection", async () => {
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(4_000)
      .mockReturnValueOnce(5_500);
    const fs = new InMemoryFs();

    try {
      const result = await toText(
        await new Bash({ fs, cwd: "/" }).exec(
          "time -p echo timed 2>command.err",
        ),
      );

      expect({
        file: await fs.readFileText("/command.err"),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }).toEqual({
        file: "",
        stdout: "timed\n",
        stderr: "real 1.50\nuser 0.00\nsys 0.00\n",
        exitCode: 0,
      });
    } finally {
      now.mockRestore();
    }
  });
});
