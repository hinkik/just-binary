import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { toText } from "../../test-utils.js";
import { collectBytes } from "../../utils/stream.js";

describe("tr with binary content", () => {
  it("should translate characters in binary content", async () => {
    const env = new Bash({
      files: {
        "/data.bin": new Uint8Array([0x61, 0x62, 0x63]), // abc
      },
    });

    const result = await toText(await env.exec("cat /data.bin | tr a-z A-Z"));
    expect(result.stdout).toBe("ABC");
    expect(result.exitCode).toBe(0);
  });

  it("passes bytes that are not valid UTF-8 through unchanged", async () => {
    const env = new Bash({
      files: { "/data.bin": new Uint8Array([0x61, 0xff, 0x62, 0xc3, 0x0a]) },
    });
    const result = await env.exec("tr a b < /data.bin");
    expect(Array.from(await collectBytes(result.stdout))).toEqual([
      0x62, 0xff, 0x62, 0xc3, 0x0a,
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("does not crash when the second set is empty", async () => {
    const env = new Bash();
    const result = await toText(await env.exec('echo abc | tr a ""'));
    expect(result.stdout).toBe("abc\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
