import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { toText } from "../../test-utils.js";

describe("read builtin", () => {
  describe("basic read", () => {
    it("should read from stdin into variable", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo "hello" | { read VAR; echo "got: $VAR"; }
      `),
      );
      expect(result.stdout).toBe("got: hello\n");
    });

    it("should read into REPLY when no variable given", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo "test" | { read; echo "REPLY=$REPLY"; }
      `),
      );
      expect(result.stdout).toBe("REPLY=test\n");
    });

    it("should read multiple words into multiple variables", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo "one two three" | { read A B C; echo "A=$A B=$B C=$C"; }
      `),
      );
      expect(result.stdout).toBe("A=one B=two C=three\n");
    });

    it("should put remaining words in last variable", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo "one two three four" | { read A B; echo "A=$A B=$B"; }
      `),
      );
      expect(result.stdout).toBe("A=one B=two three four\n");
    });
  });

  describe("read options", () => {
    it("should support -r to disable backslash escape", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo 'hello\\nworld' | { read -r VAR; echo "$VAR"; }
      `),
      );
      expect(result.stdout).toBe("hello\\nworld\n");
    });

    it("should support -p for prompt (non-interactive)", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo "test" | { read -p "Enter: " VAR; echo "$VAR"; }
      `),
      );
      expect(result.stdout).toBe("test\n");
    });

    it("should support -a to read into array", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo "a b c" | { read -a ARR; echo "\${ARR[0]} \${ARR[1]} \${ARR[2]}"; }
      `),
      );
      expect(result.stdout).toBe("a b c\n");
    });
  });

  describe("read with delimiters", () => {
    it("should support -d to set delimiter", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo -n "hello:world" | { read -d ":" VAR; echo "$VAR"; }
      `),
      );
      expect(result.stdout).toBe("hello\n");
    });
  });

  describe("read exit codes", () => {
    it("should return 0 on successful read", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo "data" | { read VAR; echo $?; }
      `),
      );
      expect(result.stdout).toBe("0\n");
    });

    it("should return 1 on EOF", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo -n "" | { read VAR; echo $?; }
      `),
      );
      expect(result.stdout).toBe("1\n");
    });
  });

  describe("read in loops", () => {
    it("should read multiple lines in while loop", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        echo -e "line1\\nline2\\nline3" | while read LINE; do
          echo "got: $LINE"
        done
      `),
      );
      expect(result.stdout).toBe("got: line1\ngot: line2\ngot: line3\n");
    });
  });

  describe("read -a with empty IFS", () => {
    it("should produce empty array for empty input with empty IFS", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        IFS=
        echo '' | (read -a a; echo "\${#a[@]}")
      `),
      );
      // When IFS is empty and input is empty, read -a should produce an empty array (0 elements)
      expect(result.stdout).toBe("0\n");
    });

    it("should read entire non-empty input as single word with empty IFS", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(`
        IFS=
        echo 'hello world' | (read -a a; echo "\${#a[@]}"; echo "\${a[0]}")
      `),
      );
      // With empty IFS, no word splitting occurs, so the entire input is one word
      expect(result.stdout).toBe("1\nhello world\n");
    });
  });

  describe("incremental consumption", () => {
    /** Lazy stdin that counts how many chunks the shell actually pulled. */
    function lazyStdin(total: number, makeChunk: (i: number) => string) {
      const state = { pulled: 0 };
      const encoder = new TextEncoder();
      let i = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i >= total) {
            controller.close();
            return;
          }
          state.pulled++;
          controller.enqueue(encoder.encode(makeChunk(i++)) as Uint8Array);
        },
      });
      return { stream, state };
    }

    it("pulls only what a single read needs from a lazy stdin", async () => {
      const { stream, state } = lazyStdin(1000, (i) => `line ${i}\n`);
      const env = new Bash();
      const result = await toText(
        await env.exec('read first; echo "got: $first"', { stdin: stream }),
      );
      expect(result.stdout).toBe("got: line 0\n");
      expect(state.pulled).toBeLessThan(5);
    });

    it("leaves the unconsumed remainder for the next consumer", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("printf 'a\\nb\\nc\\n' | { read x; read y; cat; }"),
      );
      expect(result.stdout).toBe("c\n");
    });

    it("keeps while-read loops linear over many lines", async () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n");
      const env = new Bash({ files: { "/data.txt": `${lines}\n` } });
      const start = performance.now();
      const result = await toText(
        await env.exec(
          'n=0; while read -r l; do n=$((n+1)); done < /data.txt; echo "$n"',
        ),
      );
      const elapsed = performance.now() - start;
      expect(result.stdout).toBe("3000\n");
      // Quadratic re-materialization made this take seconds; incremental
      // reads keep it well under one.
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
