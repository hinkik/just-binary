import type { Command } from "../types.js";

/**
 * The commands this package ships, as opposed to ones an embedder registered.
 * Shipped commands read stdin through the library's own helpers, so they can
 * be given in-memory streams; an embedder's command gets a platform stream.
 */
export const internalCommands: WeakSet<Command> = new WeakSet();
