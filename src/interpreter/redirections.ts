/**
 * Redirection Handling
 *
 * Handles output redirections:
 * - > : Write stdout to file
 * - >> : Append stdout to file
 * - 2> : Write stderr to file
 * - &> : Write both stdout and stderr to file
 * - >& : Redirect fd to another fd
 * - {fd}>file : Allocate FD and store in variable
 */

import type { RedirectionNode, WordNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import { envGet, envSet } from "../utils/bytes.js";
import { emptyStream, fromString } from "../utils/stream.js";
import {
  expandRedirectTarget,
  expandWord,
  hasQuotedMultiValueAt,
} from "./expansion.js";
import { result as makeResult } from "./helpers/result.js";
import type { InterpreterContext } from "./types.js";

/**
 * Check if a redirect target is valid for output (not a directory, respects noclobber).
 * Returns an error message string if invalid, null if valid.
 */
export async function checkOutputRedirectTarget(
  ctx: InterpreterContext,
  filePath: string,
  target: string,
  options: { checkNoclobber?: boolean; isClobber?: boolean },
): Promise<string | null> {
  try {
    const stat = await ctx.fs.stat(filePath);
    if (stat.isDirectory) {
      return `bash: ${target}: Is a directory\n`;
    }
    if (
      options.checkNoclobber &&
      ctx.state.options.noclobber &&
      !options.isClobber &&
      target !== "/dev/null"
    ) {
      return `bash: ${target}: cannot overwrite existing file\n`;
    }
  } catch {
    // File doesn't exist, that's ok - we'll create it
  }
  return null;
}

/**
 * Expand one redirect target using the same rules as the legacy redirect path.
 */
export async function expandRedirectionTarget(
  ctx: InterpreterContext,
  redir: RedirectionNode,
): Promise<{ target: string } | { error: string }> {
  if (redir.target.type === "HereDoc") {
    throw new Error("Here-document targets are not words");
  }

  if (redir.operator === ">&" || redir.operator === "<&") {
    if (hasQuotedMultiValueAt(ctx, redir.target)) {
      return { error: "bash: $@: ambiguous redirect\n" };
    }
    return { target: await expandWord(ctx, redir.target) };
  }

  return expandRedirectTarget(ctx, redir.target);
}

/**
 * Return the legacy diagnostic for a redirect target containing a null byte.
 */
export function getInvalidRedirectTargetError(target: string): string | null {
  if (!target.includes("\0")) {
    return null;
  }
  return `bash: ${target.replace(/\0/g, "")}: No such file or directory\n`;
}

export function getBadFileDescriptorError(fd: number): string {
  return `bash: ${fd}: Bad file descriptor\n`;
}

/**
 * Allocate the next available file descriptor (starting at 10).
 * Returns the allocated FD number.
 */
export function allocateFd(
  ctx: InterpreterContext,
  isUnavailable: (fd: number) => boolean = () => false,
): number {
  if (ctx.state.nextFd === undefined) {
    ctx.state.nextFd = 10;
  }
  while (isUnavailable(ctx.state.nextFd)) {
    ctx.state.nextFd++;
  }
  return ctx.state.nextFd++;
}

/**
 * Process FD variable redirections ({varname}>file syntax).
 * This allocates FDs and sets variables before command execution.
 * Returns an error result if there's an issue, or null if successful.
 */
export async function processFdVariableRedirections(
  ctx: InterpreterContext,
  redirections: RedirectionNode[],
  isFdUnavailable?: (fd: number) => boolean,
): Promise<ExecResult | null> {
  for (const redir of redirections) {
    if (!redir.fdVariable) {
      continue;
    }

    // Initialize fileDescriptors map if needed
    if (!ctx.state.fileDescriptors) {
      ctx.state.fileDescriptors = new Map();
    }

    // Handle close operation: {fd}>&- or {fd}<&-
    // For close operations, we look up the existing variable value (the FD number)
    // and close that FD, rather than allocating a new one.
    let expandedDupTarget: string | undefined;
    if (
      (redir.operator === ">&" || redir.operator === "<&") &&
      redir.target.type === "Word"
    ) {
      expandedDupTarget = await expandWord(ctx, redir.target as WordNode);
      if (expandedDupTarget === "-") {
        // Close operation - look up the FD from the variable and close it
        if (ctx.state.env.has(redir.fdVariable)) {
          const fdNum = Number.parseInt(
            envGet(ctx.state.env, redir.fdVariable),
            10,
          );
          if (!Number.isNaN(fdNum)) {
            ctx.state.fileDescriptors.delete(fdNum);
          }
        }
        // Don't allocate a new FD for close operations
        continue;
      }
    }

    // Allocate a new FD (for non-close operations)
    const fd = allocateFd(ctx, isFdUnavailable);

    // Set the variable to the allocated FD number
    envSet(ctx.state.env, redir.fdVariable, String(fd));

    // For file redirections, store the file path mapping
    if (redir.target.type === "Word") {
      const target =
        expandedDupTarget ?? (await expandWord(ctx, redir.target as WordNode));

      // Handle FD duplication: {fd}>&N or {fd}<&N
      if (redir.operator === ">&" || redir.operator === "<&") {
        const sourceFd = Number.parseInt(target, 10);
        if (!Number.isNaN(sourceFd)) {
          // Duplicate the source FD's content to the new FD
          const content = ctx.state.fileDescriptors.get(sourceFd);
          if (content !== undefined) {
            ctx.state.fileDescriptors.set(fd, content);
          } else {
            return makeResult(
              emptyStream(),
              fromString(getBadFileDescriptorError(sourceFd)),
              1,
            );
          }
          continue;
        }
      }

      // Store output descriptor metadata for callers that still use the
      // standalone fd-variable input/output setup helper.
      if (
        redir.operator === ">" ||
        redir.operator === ">>" ||
        redir.operator === ">|" ||
        redir.operator === "&>" ||
        redir.operator === "&>>"
      ) {
        // Mark this FD as pointing to a file (store file path for later use)
        // Use a special format to distinguish from content
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        // For truncating operators (>, >|, &>), create/truncate the file now
        if (
          redir.operator === ">" ||
          redir.operator === ">|" ||
          redir.operator === "&>"
        ) {
          await ctx.fs.writeFile(filePath, "");
        }
        ctx.state.fileDescriptors.set(fd, `__file__:${filePath}`);
      } else if (redir.operator === "<<<") {
        // For here-strings, store the target value plus newline as the FD content
        ctx.state.fileDescriptors.set(fd, `${target}\n`);
      } else if (redir.operator === "<" || redir.operator === "<>") {
        // For input redirections, read the file content
        try {
          const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
          const content = await ctx.fs.readFileText(filePath);
          ctx.state.fileDescriptors.set(fd, content);
        } catch {
          return makeResult(
            emptyStream(),
            fromString(`bash: ${target}: No such file or directory\n`),
            1,
          );
        }
      }
    }
  }

  return null; // Success
}
