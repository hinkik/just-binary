import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ProcessTable } from "../process/process-table.js";
import { type TextResult, toText } from "../test-utils.js";

function expectResult(
  result: TextResult,
  expected: { stdout: string; stderr: string; exitCode: number },
): void {
  expect({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }).toEqual(expected);
}

function sleepUntilAborted(
  _milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("kill and jobs common options", () => {
  it("accepts named terminating signals with and without SIG prefixes", async () => {
    const bash = new Bash({
      processes: new ProcessTable(),
      sleep: sleepUntilAborted,
    });
    const usr1 = process.platform === "darwin" ? 158 : 138;
    const usr2 = process.platform === "darwin" ? 159 : 140;
    const result = await toText(
      await bash.exec(`
        sleep 9 & p=$!; kill -HUP "$p"; wait "$p"; echo HUP:$?
        sleep 9 & p=$!; kill -SIGHUP "$p"; wait "$p"; echo SIGHUP:$?
        sleep 9 & p=$!; kill -INT "$p"; wait "$p"; echo INT:$?
        sleep 9 & p=$!; kill -QUIT "$p"; wait "$p"; echo QUIT:$?
        sleep 9 & p=$!; kill -KILL "$p"; wait "$p"; echo KILL:$?
        sleep 9 & p=$!; kill -s TERM "$p"; wait "$p"; echo TERM:$?
        sleep 9 & p=$!; kill -USR1 "$p"; wait "$p"; echo USR1:$?
        sleep 9 & p=$!; kill -SIGUSR2 "$p"; wait "$p"; echo USR2:$?
      `),
    );

    expectResult(result, {
      stdout:
        "HUP:129\n" +
        "SIGHUP:129\n" +
        "INT:130\n" +
        "QUIT:131\n" +
        "KILL:137\n" +
        "TERM:143\n" +
        `USR1:${usr1}\n` +
        `USR2:${usr2}\n`,
      stderr: "",
      exitCode: 0,
    });
  });

  it("accepts STOP and CONT without terminating a running job", async () => {
    const bash = new Bash({
      processes: new ProcessTable(),
      sleep: sleepUntilAborted,
    });
    const result = await toText(
      await bash.exec(
        'sleep 9 & p=$!; kill -STOP "$p"; stop=$?; ' +
          'kill -CONT "$p"; cont=$?; kill -KILL "$p"; wait "$p"; ' +
          'printf "stop=%s cont=%s wait=%s\\n" "$stop" "$cont" "$?"',
      ),
    );

    expectResult(result, {
      stdout: "stop=0 cont=0 wait=137\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("accepts numeric equivalents for the additional standard signals", async () => {
    const bash = new Bash({
      processes: new ProcessTable(),
      sleep: sleepUntilAborted,
    });
    const usr1 = process.platform === "darwin" ? 30 : 10;
    const usr2 = process.platform === "darwin" ? 31 : 12;
    const stop = process.platform === "darwin" ? 17 : 19;
    const cont = process.platform === "darwin" ? 19 : 18;
    const result = await toText(
      await bash.exec(`
        sleep 9 & p=$!; kill -1 "$p"; wait "$p"; echo HUP:$?
        sleep 9 & p=$!; kill -3 "$p"; wait "$p"; echo QUIT:$?
        sleep 9 & p=$!; kill -${usr1} "$p"; wait "$p"; echo USR1:$?
        sleep 9 & p=$!; kill -${usr2} "$p"; wait "$p"; echo USR2:$?
        sleep 9 & p=$!; kill -${stop} "$p"; a=$?; kill -${cont} "$p"; b=$?
        kill -9 "$p"; wait "$p"; printf "STOP:%s CONT:%s KILL:%s\\n" "$a" "$b" "$?"
      `),
    );

    expectResult(result, {
      stdout:
        "HUP:129\n" +
        "QUIT:131\n" +
        `USR1:${128 + usr1}\n` +
        `USR2:${128 + usr2}\n` +
        "STOP:0 CONT:0 KILL:137\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("matches Bash invalid-signal wording and status", async () => {
    const result = await toText(await new Bash().exec("kill -BOGUS 999999"));

    expectResult(result, {
      stdout: "",
      stderr: "bash: kill: BOGUS: invalid signal specification\n",
      exitCode: 1,
    });
  });

  it("lists signal numbers and names", async () => {
    const result = await toText(
      await new Bash().exec(
        'printf "term=%s nine=%s\\n" "$(kill -l TERM)" "$(kill -l 9)"',
      ),
    );

    expectResult(result, {
      stdout: "term=15 nine=KILL\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("accepts kill -l without an operand", async () => {
    const usr1 = process.platform === "darwin" ? 30 : 10;
    const usr2 = process.platform === "darwin" ? 31 : 12;
    const stop = process.platform === "darwin" ? 17 : 19;
    const cont = process.platform === "darwin" ? 19 : 18;
    const result = await toText(await new Bash().exec("kill -l"));

    expectResult(result, {
      stdout:
        "1) SIGHUP 2) SIGINT 3) SIGQUIT 9) SIGKILL 15) SIGTERM " +
        `${usr1}) SIGUSR1 ${usr2}) SIGUSR2 ${stop}) SIGSTOP ${cont}) SIGCONT\n`,
      stderr: "",
      exitCode: 0,
    });
  });

  it("supports jobs -p and the canonical kill jobs idiom", async () => {
    const bash = new Bash({
      processes: new ProcessTable(),
      sleep: sleepUntilAborted,
    });
    const result = await toText(
      await bash.exec(
        'sleep 9 & p=$!; listed=$(jobs -p); kill $(jobs -p); wait "$p"; ' +
          'printf "listed=%s wait=%s\\n" "$listed" "$?"',
      ),
    );

    expectResult(result, {
      stdout: "listed=1000 wait=143\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("supports jobs -l, -r, -s, and -n output modes", async () => {
    const bash = new Bash({
      processes: new ProcessTable(),
      sleep: sleepUntilAborted,
    });
    const result = await toText(
      await bash.exec(`
        sleep 9 &
        jobs -l
        jobs -r
        printf 'stopped=<'; jobs -s; printf '>\\n'
        jobs -n
        printf 'unchanged=<'; jobs -n; printf '>\\n'
        kill $!; wait $!
      `),
    );

    expectResult(result, {
      stdout:
        "[1]+ 1000 Running                 sleep 9 &\n" +
        "[1]+  Running                 sleep 9 &\n" +
        "stopped=<>\n" +
        "[1]+  Running                 sleep 9 &\n" +
        "unchanged=<>\n",
      stderr: "",
      exitCode: 143,
    });
  });

  it("supports jobs -x jobspec substitution", async () => {
    const bash = new Bash({
      processes: new ProcessTable(),
      sleep: sleepUntilAborted,
    });
    const result = await toText(
      await bash.exec(
        "sleep 9 & jobs -x printf 'pid:%s\\n' %1; kill $!; wait $!",
      ),
    );

    expectResult(result, {
      stdout: "pid:1000\n",
      stderr: "",
      exitCode: 143,
    });
  });

  it("uses Bash's jobs usage for an unknown option", async () => {
    const result = await toText(await new Bash().exec("jobs -z"));

    expectResult(result, {
      stdout: "",
      stderr:
        "bash: jobs: -z: invalid option\n" +
        "jobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]\n",
      exitCode: 2,
    });
  });
});
