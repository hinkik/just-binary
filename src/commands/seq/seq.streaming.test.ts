import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { toText } from "../../test-utils.js";

describe("seq streams without a hidden cap", () => {
  it("produces 1,000,000 lines (no maxArrayElements cap)", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("seq 1 1000000 | wc -l"));
    expect(r.exitCode).toBe(0);
    expect(Number(r.stdout.trim())).toBe(1000000);
  });

  it("supports early-exit through head", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("seq 1 100000000 | head -c 10"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1\n2\n3\n4\n5\n");
  });

  it("emits a trailing newline after the last value", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("seq 1 3"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1\n2\n3\n");
  });

  it("honors -s separator and emits the trailing newline once", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("seq -s, 1 5"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1,2,3,4,5\n");
  });

  it("honors -w equalize-width", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("seq -w 8 12"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("08\n09\n10\n11\n12\n");
  });

  it("handles descending sequences", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("seq 3 -1 1"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("3\n2\n1\n");
  });

  it("returns empty output when first > last with positive step", async () => {
    const env = new Bash();
    const r = await toText(await env.exec("seq 5 3"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});
