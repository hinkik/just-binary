/**
 * Streaming variant of searchContent.
 *
 * Reads a ByteStream line-by-line, matches each line against the regex, and
 * builds the formatted output as chunks of text. Memory usage is bounded by
 * the size of the output plus the before-context ring buffer — never by the
 * input size — so commands using this can grep over arbitrary-size files.
 *
 * Supports the common options: invertMatch, showLineNumbers, onlyMatching,
 * filename, beforeContext/afterContext, maxCount, countOnly, passthru,
 * replace. Multiline, vimgrep, and showByteOffset are NOT supported here —
 * use searchContent for those (they require full-content semantics anyway).
 */

import type { UserRegex } from "../../regex/index.js";
import {
  type ByteStream,
  fromString,
  streamLines,
} from "../../utils/stream.js";
import type { SearchOptions } from "./matcher.js";

export interface StreamSearchResult {
  /** Stream of formatted output (matched lines, contexts, count) */
  output: ByteStream;
  /** Whether any line matched (resolved after the stream is drained) */
  matched: Promise<boolean>;
  /** Total match count (lines or individual matches depending on opts) */
  matchCount: Promise<number>;
}

/**
 * Subset of options that the streaming searcher can handle natively.
 * Callers should fall back to searchContent if their options need
 * full-content semantics.
 */
export function canStream(options: SearchOptions): boolean {
  return !options.multiline && !options.vimgrep && !options.showByteOffset;
}

export function searchStream(
  input: ByteStream,
  regex: UserRegex,
  options: SearchOptions = {},
): StreamSearchResult {
  const {
    invertMatch = false,
    showLineNumbers = false,
    countOnly = false,
    countMatches = false,
    filename = "",
    onlyMatching = false,
    beforeContext = 0,
    afterContext = 0,
    maxCount = 0,
    contextSeparator = "--",
    showColumn = false,
    replace = null,
    passthru = false,
    kResetGroup,
  } = options;

  let matchedResolve!: (v: boolean) => void;
  let countResolve!: (v: number) => void;
  const matched = new Promise<boolean>((r) => {
    matchedResolve = r;
  });
  const matchCount = new Promise<number>((r) => {
    countResolve = r;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      let lineNum = 0;
      let totalMatchCount = 0;
      let matchedAny = false;
      const before: Array<{ n: number; text: string }> = []; // ring of unmatched preceding lines
      let afterRemaining = 0;
      let lastEmittedLine = 0; // 0 = none; helps detect gaps for "--"
      const prefix = filename ? `${filename}:` : "";
      const contextPrefix = filename ? `${filename}-` : "";

      const formatLine = (line: string, n: number, isMatch: boolean): string => {
        const sep = isMatch ? ":" : "-";
        const fileTag = filename ? (isMatch ? prefix : contextPrefix) : "";
        const lineTag = showLineNumbers ? `${n}${sep}` : "";
        // Column number support — only show for matched lines
        if (showColumn && isMatch) {
          regex.lastIndex = 0;
          const m = regex.exec(line);
          const col = m ? m.index + 1 : 0;
          return `${fileTag}${lineTag}${col}${sep}${line}\n`;
        }
        return `${fileTag}${lineTag}${line}\n`;
      };

      const emit = (s: string) => {
        if (s.length > 0) controller.enqueue(new TextEncoder().encode(s) as Uint8Array);
      };

      try {
        for await (const lineBytes of streamLines(input)) {
          lineNum++;
          const line = decoder.decode(lineBytes);

          regex.lastIndex = 0;
          let isMatch: boolean;
          if (countMatches || (onlyMatching && !invertMatch)) {
            // We need to count individual matches; isMatch is "any match"
            isMatch = regex.test(line);
            regex.lastIndex = 0;
          } else {
            isMatch = regex.test(line);
          }
          if (invertMatch) isMatch = !isMatch;

          if (isMatch) {
            matchedAny = true;

            // For -c / --count-matches we don't emit content, just count.
            if (countOnly) {
              totalMatchCount++;
              if (maxCount > 0 && totalMatchCount >= maxCount) break;
              continue;
            }
            if (countMatches) {
              // Count individual matches on this line
              regex.lastIndex = 0;
              for (
                let m = regex.exec(line);
                m !== null;
                m = regex.exec(line)
              ) {
                totalMatchCount++;
                if (m[0].length === 0) regex.lastIndex++;
              }
              continue;
            }

            // Emit a separator only if there was a gap between this match's
            // (or its before-context's) first line and the previously emitted
            // line. With overlapping context windows there is no gap.
            const firstLineToEmit =
              before.length > 0 ? before[0].n : lineNum;
            if (
              (beforeContext > 0 || afterContext > 0) &&
              lastEmittedLine > 0 &&
              firstLineToEmit > lastEmittedLine + 1
            ) {
              emit(`${contextSeparator}\n`);
            }
            // Emit before-context
            for (const b of before) {
              emit(b.text);
              lastEmittedLine = b.n;
            }
            before.length = 0;

            if (onlyMatching) {
              // Emit each match separately
              regex.lastIndex = 0;
              for (
                let m = regex.exec(line);
                m !== null;
                m = regex.exec(line)
              ) {
                const matchText =
                  kResetGroup !== undefined && m[kResetGroup] !== undefined
                    ? m[kResetGroup]
                    : m[0];
                const out = replace !== null
                  ? applyReplacement(replace, m)
                  : matchText;
                emit(formatLine(out, lineNum, true));
                totalMatchCount++;
                if (m[0].length === 0) regex.lastIndex++;
              }
            } else {
              let lineOut = line;
              if (replace !== null) {
                regex.lastIndex = 0;
                const parts: string[] = [];
                let lastIdx = 0;
                let m = regex.exec(line);
                while (m !== null) {
                  parts.push(line.slice(lastIdx, m.index));
                  parts.push(applyReplacement(replace, m));
                  lastIdx = m.index + m[0].length;
                  if (m[0].length === 0) regex.lastIndex++;
                  m = regex.exec(line);
                }
                parts.push(line.slice(lastIdx));
                lineOut = parts.join("");
              }
              emit(formatLine(lineOut, lineNum, true));
              lastEmittedLine = lineNum;
              totalMatchCount++;
            }

            afterRemaining = afterContext;
            // Don't break immediately on maxCount — we still owe the
            // after-context lines for this match.
          } else if (afterRemaining > 0) {
            emit(formatLine(line, lineNum, false));
            lastEmittedLine = lineNum;
            afterRemaining--;
            if (afterRemaining === 0 && maxCount > 0 && totalMatchCount >= maxCount) {
              break;
            }
          } else if (passthru) {
            emit(formatLine(line, lineNum, false));
            lastEmittedLine = lineNum;
          } else if (beforeContext > 0) {
            before.push({ n: lineNum, text: formatLine(line, lineNum, false) });
            while (before.length > beforeContext) before.shift();
          }
          // If we hit maxCount and after-context is exhausted (or never
          // requested), stop processing further input.
          if (
            maxCount > 0 &&
            totalMatchCount >= maxCount &&
            afterRemaining === 0
          ) {
            break;
          }
        }

        // Count mode: emit the final count
        if (countOnly) {
          const countStr = filename
            ? `${filename}:${totalMatchCount}`
            : String(totalMatchCount);
          emit(`${countStr}\n`);
        } else if (countMatches) {
          const countStr = filename
            ? `${filename}:${totalMatchCount}`
            : String(totalMatchCount);
          emit(`${countStr}\n`);
        }

        controller.close();
        matchedResolve(matchedAny);
        countResolve(totalMatchCount);
      } catch (e) {
        controller.error(e);
        matchedResolve(matchedAny);
        countResolve(totalMatchCount);
      }
    },
  });

  return { output: stream, matched, matchCount };
}

function applyReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(
    /\$(&|\d+|<([^>]+)>)/g,
    (_, ref: string, namedGroup: string | undefined) => {
      if (ref === "&") return match[0];
      if (namedGroup !== undefined) return match.groups?.[namedGroup] ?? "";
      const groupNum = parseInt(ref, 10);
      return match[groupNum] ?? "";
    },
  );
}

// Avoid unused-import lint while we keep fromString around for callers
// that may construct chunks from strings.
void fromString;
