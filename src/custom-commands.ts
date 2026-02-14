/**
 * Custom Commands API
 *
 * Provides types and utilities for registering user-provided TypeScript commands.
 */

import type { Command, CommandContext, ExecResult } from "./types.js";
import { createStringEnvAdapter, decodeArgs, encode } from "./utils/bytes.js";

/**
 * An ExecResult with string stdout/stderr, for ergonomic custom commands.
 */
export interface StringExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Return type for custom commands — either binary ExecResult or string-based.
 */
export type CustomExecResult = ExecResult | StringExecResult;

/**
 * User-facing CommandContext with string-typed env for ergonomics.
 * Internal commands use Map<string, Uint8Array>, but custom commands get Map<string, string>.
 */
export interface CustomCommandContext extends Omit<CommandContext, "env"> {
  env: Map<string, string>;
}

/**
 * A custom command - either a Command object or a lazy loader.
 */
export type CustomCommand = Command | LazyCommand;

/**
 * Lazy-loaded custom command (for code-splitting).
 */
export interface LazyCommand {
  name: string;
  load: () => Promise<Command>;
}

/**
 * Type guard to check if a custom command is lazy-loaded.
 */
export function isLazyCommand(cmd: CustomCommand): cmd is LazyCommand {
  return "load" in cmd && typeof cmd.load === "function";
}

/**
 * Define a TypeScript command with type inference.
 * Convenience wrapper - you can also just use the Command interface directly.
 *
 * @example
 * ```ts
 * const hello = defineCommand("hello", async (args, ctx) => {
 *   const name = args[0] || "world";
 *   return { stdout: `Hello, ${name}!\n`, stderr: "", exitCode: 0 };
 * });
 *
 * const bash = new Bash({ customCommands: [hello] });
 * await bash.exec("hello Alice"); // "Hello, Alice!\n"
 * ```
 */
export function defineCommand(
  name: string,
  execute: (
    args: string[],
    ctx: CustomCommandContext,
  ) => Promise<CustomExecResult>,
): Command {
  return {
    name,
    async execute(
      rawArgs: Uint8Array[],
      ctx: CommandContext,
    ): Promise<ExecResult> {
      const stringCtx: CustomCommandContext = {
        ...ctx,
        env: createStringEnvAdapter(ctx.env),
      };
      const raw = await execute(decodeArgs(rawArgs), stringCtx);
      if (typeof raw.stdout === "string") {
        return {
          stdout: encode(raw.stdout),
          stderr: encode(raw.stderr as string),
          exitCode: raw.exitCode,
        };
      }
      return raw as ExecResult;
    },
  };
}

/**
 * Create a lazy-loaded wrapper for a custom command.
 * The command is only loaded when first executed.
 */
export function createLazyCustomCommand(lazy: LazyCommand): Command {
  let cached: Command | null = null;
  return {
    name: lazy.name,
    async execute(
      args: Uint8Array[],
      ctx: CommandContext,
    ): Promise<ExecResult> {
      if (!cached) {
        cached = await lazy.load();
      }
      return cached.execute(args, ctx);
    },
  };
}
