import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

async function compareScopeOutputs(
  env: Awaited<ReturnType<typeof setupFiles>>,
  testDir: string,
  command: string,
): Promise<void> {
  await compareOutputs(env, testDir, command, { compareStderr: true });
}

describe("scope channels - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("snapshots descriptor bindings left to right for a group", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "{ echo a; echo e >&2; } > combined 2>&1; cat combined",
    );
  });

  it("redirects subshell and function-definition output", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "(echo subshell) > sub; f() { echo function; } > fn; f; cat sub fn",
    );
  });

  it("expands function-definition redirects at call time", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      'i=0; f() { printf "body:%s\\n" "$i"; } > "def-$((i++))"; i=4; f > call; printf "i:%s\\n" "$i"; printf "files:"; printf "<%s>" def-*; printf "\\ndef:"; cat def-*; printf "call:"; cat call',
    );
  });

  it("treats explicit output <& duplication like real bash", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "{ echo group; } 1<&2; (echo subshell) 1<&2; f() { echo function; } 1<&2; f; { echo fd3 >&3; } 3<&1",
    );
  });

  it("expands explicit output <& call redirects once", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "i=2; f() { echo function; }; f 1<&$((i++)); printf 'i=%s\\n' \"$i\"",
    );
  });

  it("routes temporary nonstandard fds through nested scope leaves", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "{ echo group >&3; } 3>g; (echo sub >&3) 3>s; f() { echo definition >&3; } 3>f; f; h() { echo call >&3; }; h 3>c; cat g s f c",
    );
  });

  it("lets later leaf redirects override temporary fd targets", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "{ echo stderr >&3 1>&2; } 3>first; { echo file 1>&2 >&3; } 3>second; cat first second",
    );
  });

  // The next two assert ORDERING — the invalid redirect is rejected before the
  // scope body runs — not the wording of bash's diagnostic. stderr is
  // discarded because bash 5.x prefixes "line N: " where bash 3.2 does not,
  // and CI re-records fixtures against its own bash. just-binary's exact
  // message text stays pinned by unit tests (scope-channels-fd-redirections,
  // scope-channels-descriptor-metadata, persistent-exec-redirections).
  it("rejects a nonnumeric <& target before running the scope", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      // 2>/dev/null must precede the failing redirect: bash applies
      // redirections left to right, so a later discard would not yet be
      // installed when 1<&word fails.
      'output=$({ echo never; } 2>/dev/null 1<&word); status=$?; printf \'out=[%s]\\nstatus=%s\\n\' "$output" "$status"',
    );
  });

  it("opens inherited-fd leaf redirects before command execution", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      'output=$({ mkdir made 1<&word; [[ -d made ]] && echo exists >&3; } 3>out 2>/dev/null); status=$?; printf \'out=[%s]\\nstatus=%s\\n\' "$output" "$status"; [[ -d made ]] && echo made || echo no-made; [[ -e out ]] && echo has-out || echo no-out; cat out 2>/dev/null',
    );
  });

  it("isolates subshell redirect-target expansion side effects", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      'i=0; (:)>$((i++)); printf \'i=%s file=%s\\n\' "$i" "$(cat 0)"',
    );
  });

  it("pipes group and subshell stages", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "{ echo ab; echo cd; } | tr a-z A-Z; (echo abc; echo xyz) | rev",
    );
  });

  it("captures nested scope stdout and forwards stderr", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "out=$( (echo sub; echo se >&2); { echo group; echo ge >&2; }; f() { echo fn; echo fe >&2; }; f ); printf '<%s>\\n' \"$out\"",
    );
  });

  it("preserves exit, return, and errexit status", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "(exit 5); echo sub:$?; f() { return 3; }; f; echo fn:$?; (set -e; { false; echo never; }); echo errexit:$?",
    );
  });

  it("redirects eval and source bodies at their call sites", async () => {
    const env = await setupFiles(testDir, {
      sourced: "echo source-out; echo source-error >&2",
    });
    await compareScopeOutputs(
      env,
      testDir,
      "eval 'echo eval-out; echo eval-error >&2' > eval-file 2>&1; source sourced > source-file 2>&1; cat eval-file source-file",
    );
  });

  it("forwards nested bash output once per loop iteration", async () => {
    const env = await setupFiles(testDir, {});
    await compareScopeOutputs(
      env,
      testDir,
      "for i in 1 2; do bash -c 'echo inner'; done",
    );
  });
});
