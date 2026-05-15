import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { toText } from "../../test-utils.js";

describe("yes streams forever", () => {
  it("yes | head -c 10 returns 'y\\ny\\n...'", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("yes | head -c 10"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("y\ny\ny\ny\ny\n");
  });

  it("yes hello | head -c 18 repeats the line", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("yes hello | head -c 18"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello\nhello\nhello\n");
  });

  it("yes 'a b c' joins all args with spaces", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("yes 'a b c' | head -c 12"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("a b c\na b c\n");
  });

  it("yes | head -c 1MB exits in bounded memory", async () => {
    // No assertion beyond "doesn't hang or OOM"; if yes were buffering
    // this would either explode RAM or take many seconds.
    const env = new Bash();
    const r = await toText(await env.exec("yes | head -c 1048576 | wc -c"));
    expect(r.exitCode).toBe(0);
    expect(Number(r.stdout.trim())).toBe(1048576);
  });
});
