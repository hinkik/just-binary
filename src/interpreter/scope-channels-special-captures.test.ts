import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { toText } from "../test-utils.js";

describe("scope channel metadata in specialized captures", () => {
  it("duplicates arithmetic substitution stdout from the active collector", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        x7=41
        {
          direct=$(( $(: {copy}>&1; echo 7 >&$copy) + 1 ))
          dynamic=$(( x$(: {copy}>&1; echo 7 >&$copy) ))
          printf 'direct:%s dynamic:%s\\n' "$direct" "$dynamic"
        } > /outer
        cat /outer
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/outer"),
    }).toEqual({
      stdout: "direct:8 dynamic:41\n",
      stderr: "",
      exitCode: 0,
      file: "direct:8 dynamic:41\n",
    });
  });

  it("duplicates associative-subscript captures for dollar and backticks", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        declare -A values
        values[alpha]=dollar
        values[beta]=backtick
        {
          dollar=\${values[$(: {copy}>&1; echo alpha >&$copy)]}
          backtick=\${values[\`: {copy}>&1; echo beta >&$copy\`]}
          printf 'dollar:%s backtick:%s\\n' "$dollar" "$backtick"
        } > /outer
        cat /outer
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/outer"),
    }).toEqual({
      stdout: "dollar:dollar backtick:backtick\n",
      stderr: "",
      exitCode: 0,
      file: "dollar:dollar backtick:backtick\n",
    });
  });

  it("duplicates extglob pattern captures for dollar and backticks", async () => {
    const bash = new Bash({
      cwd: "/work",
      files: { "/work/target": "" },
    });
    const result = await toText(
      await bash.exec(`
        shopt -s extglob
        capture_pattern() {
          : {copy}>&1
          echo target >&$copy
        }
        {
          printf 'dollar:%s\\n' @($(capture_pattern))
          printf 'backtick:%s\\n' @(\`capture_pattern\`)
        } > /outer
        cat /outer
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/outer"),
    }).toEqual({
      stdout: "dollar:target\nbacktick:target\n",
      stderr: "",
      exitCode: 0,
      file: "dollar:target\nbacktick:target\n",
    });
  });
});
