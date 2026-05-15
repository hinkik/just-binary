/**
 * Subshell stdout propagation tests.
 *
 * Covers the three subshell forms — `bash -c '<pipeline>'`, `(...)` group,
 * and `$(...)` command substitution — and asserts that the inner
 * pipeline's stdout reaches the outer scope. These are guard tests for
 * regressions of the form "subshell runs the pipeline but its output is
 * silently dropped".
 */

import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { defineCommand } from "./custom-commands.js";
import { toText } from "./test-utils.js";

function makeStreamCommand(name: string, lines: number) {
  return defineCommand(name, async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n >= lines) {
          controller.close();
          return;
        }
        controller.enqueue(
          new TextEncoder().encode(`line${n}\n`) as Uint8Array,
        );
        n++;
      },
    });
    return {
      stdout: stream,
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exitCode: 0,
    };
  });
}

describe("subshell stdout propagates", () => {
  describe("bash -c", () => {
    it("forwards builtin pipeline stdout", async () => {
      const env = new Bash();
      const r = await toText(await env.exec(`bash -c 'echo hi | wc -l'`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("1\n");
    });

    it("forwards seq | tr piped output", async () => {
      const env = new Bash();
      const r = await toText(
        await env.exec(`bash -c 'seq 1 3 | tr "\\n" ","'`),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("1,2,3,");
    });

    it("forwards stream-producing custom command piped through wc", async () => {
      const env = new Bash({
        customCommands: [makeStreamCommand("docstream", 10004)],
      });
      const r = await toText(await env.exec(`bash -c 'docstream | wc -l'`));
      expect(r.exitCode).toBe(0);
      expect(Number(r.stdout.trim())).toBe(10004);
    });

    it("forwards custom command output unpiped", async () => {
      const env = new Bash({
        customCommands: [makeStreamCommand("docstream", 3)],
      });
      const r = await toText(await env.exec(`bash -c 'docstream'`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("line0\nline1\nline2\n");
    });

    it("forwards stdout when the inner pipeline writes large output", async () => {
      const env = new Bash();
      const r = await toText(await env.exec(`bash -c 'seq 1 1000 | wc -l'`));
      expect(r.exitCode).toBe(0);
      expect(Number(r.stdout.trim())).toBe(1000);
    });
  });

  describe("group ( ... )", () => {
    it("forwards inner pipeline output", async () => {
      const env = new Bash();
      const r = await toText(await env.exec(`(seq 1 5 | wc -l)`));
      expect(r.exitCode).toBe(0);
      expect(Number(r.stdout.trim())).toBe(5);
    });

    it("forwards inner pipeline output through outer pipe", async () => {
      const env = new Bash();
      const r = await toText(await env.exec(`(seq 1 5) | wc -l`));
      expect(r.exitCode).toBe(0);
      expect(Number(r.stdout.trim())).toBe(5);
    });

    it("custom stream command inside group", async () => {
      const env = new Bash({
        customCommands: [makeStreamCommand("docstream", 100)],
      });
      const r = await toText(await env.exec(`(docstream | wc -l)`));
      expect(r.exitCode).toBe(0);
      expect(Number(r.stdout.trim())).toBe(100);
    });
  });

  describe("$(...)", () => {
    it("captures inner pipeline output as substitution value", async () => {
      const env = new Bash();
      const r = await toText(await env.exec(`echo $(seq 1 3 | wc -l)`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("3\n");
    });

    it("captures custom stream command via $(...)", async () => {
      const env = new Bash({
        customCommands: [makeStreamCommand("docstream", 7)],
      });
      const r = await toText(await env.exec(`echo $(docstream | wc -l)`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("7\n");
    });
  });
});
