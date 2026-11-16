import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { collectText } from "../utils/stream.js";

async function run(script: string): Promise<string> {
  const result = await new Bash().exec(script);
  return (
    (await collectText(result.stdout)) + (await collectText(result.stderr))
  );
}

describe("arithmetic fast path", () => {
  it("evaluates plain integer expressions", async () => {
    expect(
      await run(
        "i=5; j=3; echo $((i + j * 2)) $((i > j && j)) $((i++ + ++j)) $i $j",
      ),
    ).toBe("11 1 9 6 4\n");
    expect(
      await run("n=0; for ((i=0; i<5; i++)); do ((n += i)); done; echo $n"),
    ).toBe("10\n");
  });

  it("undoes its assignments when it has to give up", async () => {
    // `e` holds an expression, which only the general evaluator resolves.
    // The assignments before it must not have been applied twice.
    expect(await run("e='1+2'; i=0; echo $(( (i += 5) + e )) $i")).toBe(
      "8 5\n",
    );
    expect(await run("e='1+2'; i=0; echo $(( i++ + e )) $i")).toBe("3 1\n");
    expect(await run("e='1+2'; echo $(( (new = 7) + e )) $new")).toBe("10 7\n");
  });

  it("keeps textual substitution of $var", async () => {
    expect(await run("x='1 + 2'; echo $(( $x * 3 )) $(( x * 3 ))")).toBe(
      "7 9\n",
    );
    expect(await run("x=4; echo $(( $x * 3 ))")).toBe("12\n");
  });

  it("reports errors as before", async () => {
    // stdout, then stderr.
    expect(await run("i=1; echo $((i / 0)); echo next")).toBe(
      "next\nbash: division by 0\n",
    );
    expect(await run("set -u; echo $((missing + 1))")).toBe(
      "bash: missing: unbound variable\n",
    );
  });
});

describe("word fast path", () => {
  it("leaves splitting and globbing to the general path", async () => {
    expect(
      await run(
        'a="x y"; b="*"; n=""; set -- $a; echo $# "$a" $n end; cd /; mkdir -p /g; touch /g/f1 /g/f2; cd /g; echo $b "$b"',
      ),
    ).toBe("2 x y end\nf1 f2 *\n");
  });

  it("respects IFS for unquoted values", async () => {
    expect(await run('v=a:b; IFS=:; set -- $v; echo $# "$1" "$2"')).toBe(
      "2 a b\n",
    );
    // 15 split on "5" leaves one field, as in bash.
    expect(await run("IFS=5; i=4; set -- $((i + 11)); echo $# $1")).toBe(
      "1 1\n",
    );
  });

  it("keeps bytes that are not valid UTF-8", async () => {
    expect(await run('x=$\'\\xff\\x41\'; y="$x"; echo -n "$y" | wc -c')).toBe(
      "2\n",
    );
  });

  it("reads loop input a line at a time", async () => {
    expect(
      await run(
        "printf 'a 1\\nb 2\\nc 3\\n' | while read -r k v; do echo \"$v$k\"; done",
      ),
    ).toBe("1a\n2b\n3c\n");
    expect(
      await run(
        "printf 'one\\ntwo\\nthree\\n' | { read -r first; cat; echo \"[$first]\"; }",
      ),
    ).toBe("two\nthree\n[one]\n");
  });

  it("appends to and iterates large arrays", async () => {
    expect(
      await run(
        'for ((i=0; i<3000; i++)); do a+=($i); done; a[5000]=x; a+=(y); unset "a[1]"; echo ${#a[@]} ${a[5001]} ${a[2999]} ${a[0]} "${a[1]}" ${a[2]}',
      ),
    ).toBe("3001 y 2999 0  2\n");
  });
});

describe("arithmetic fast path with $-named targets", () => {
  it("assigns to the variable a $name names", async () => {
    expect(
      await run(
        'x=y; echo $(( $x = 4 )) "x=$x y=$y"; x=y; y=1; echo $(( $x += 4 )) "x=$x y=$y"',
      ),
    ).toBe("4 x=y y=4\n5 x=y y=5\n");
    expect(await run('x=y; v=$(( $x = 4 )); echo "v=$v x=$x y=$y"')).toBe(
      "v=4 x=y y=4\n",
    );
    expect(await run("x=7; echo $(( ++$x )) x=$x")).toBe("7 x=7\n");
  });
});
