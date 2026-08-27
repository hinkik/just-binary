import { describe, expect, it } from "vitest";
import { matchGlob } from "./glob.js";

describe("matchGlob", () => {
  it("matches the glob wildcards", () => {
    expect(matchGlob("report.docx", "*.docx")).toBe(true);
    expect(matchGlob("report.docx", "*.pdf")).toBe(false);
    expect(matchGlob("a1.txt", "a?.txt")).toBe(true);
    expect(matchGlob("a12.txt", "a?.txt")).toBe(false);
    expect(matchGlob("b.txt", "[ab].txt")).toBe(true);
    expect(matchGlob("c.txt", "[ab].txt")).toBe(false);
  });

  it("honours ignoreCase and stripQuotes", () => {
    expect(matchGlob("REPORT.DOCX", "*.docx", { ignoreCase: true })).toBe(true);
    expect(matchGlob("REPORT.DOCX", "*.docx")).toBe(false);
    expect(matchGlob("report.docx", '"*.docx"', { stripQuotes: true })).toBe(
      true,
    );
  });

  /**
   * The compiled-regex cache is process-scoped and its keys are caller data
   * (`find -name`, grep include/exclude), so a caller that builds a pattern per
   * item would grow it without bound. Eviction must therefore be invisible:
   * a pattern that was dropped is simply recompiled on next use.
   */
  it("keeps matching correctly across far more patterns than it caches", () => {
    // Well past the cache bound, so early entries are certainly evicted.
    for (let i = 0; i < 2500; i++) {
      expect(matchGlob(`file-${i}-x.txt`, `file-${i}-?.txt`)).toBe(true);
      expect(matchGlob(`file-${i}-xy.txt`, `file-${i}-?.txt`)).toBe(false);
    }
    // An evicted pattern still behaves identically after recompilation.
    expect(matchGlob("file-0-x.txt", "file-0-?.txt")).toBe(true);
    expect(matchGlob("file-0-xy.txt", "file-0-?.txt")).toBe(false);
  });
});
