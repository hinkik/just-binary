import type { RedirectionNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import { envGet, envSet } from "../utils/bytes.js";
import { failure } from "./helpers/result.js";
import type { OutputChannels, OutputSink } from "./output-channels.js";
import {
  allocateFd,
  checkOutputRedirectTarget,
  expandRedirectionTarget,
  getBadFileDescriptorError,
  getInvalidRedirectTargetError,
} from "./redirections.js";
import type { InterpreterContext } from "./types.js";

export interface CompiledOutputRedirections {
  channels: OutputChannels;
  legacyRedirections: RedirectionNode[];
  error?: ExecResult;
}

interface InstalledFileSink {
  sink: OutputSink;
  descriptor: string;
}

interface CompileOptions {
  persistent?: boolean;
}

const nullSink: OutputSink = {
  write() {},
};

const fullSink: OutputSink = {
  write() {
    const error = new Error(
      "bash: echo: write error: No space left on device\n",
    ) as Error & { code: string };
    error.code = "ENOSPC";
    return Promise.reject(error);
  },
};

function isInputRedirection(redir: RedirectionNode): boolean {
  return (
    redir.target.type === "HereDoc" ||
    redir.operator === "<" ||
    redir.operator === "<&" ||
    redir.operator === "<>" ||
    redir.operator === "<<<" ||
    redir.operator === "<<" ||
    redir.operator === "<<-"
  );
}

function queuedFileSink(ctx: InterpreterContext, filePath: string): OutputSink {
  let writeChain = Promise.resolve();
  return {
    write(chunk) {
      const write = writeChain.then(() => ctx.fs.appendFile(filePath, chunk));
      writeChain = write.catch(() => undefined);
      return write;
    },
  };
}

function resolveDescriptorSink(
  ctx: InterpreterContext,
  channels: OutputChannels,
  descriptors: Map<number, string>,
  fd: number,
  visited = new Set<number>(),
): OutputSink | undefined {
  const installed = channels.get(fd);
  if (installed) {
    return installed;
  }
  if (visited.has(fd)) {
    return undefined;
  }
  visited.add(fd);

  const descriptor = descriptors.get(fd);
  let sink: OutputSink | undefined;
  if (descriptor?.startsWith("__file__:")) {
    sink = queuedFileSink(ctx, descriptor.slice(9));
  } else if (descriptor?.startsWith("__file_append__:")) {
    sink = queuedFileSink(ctx, descriptor.slice(16));
  } else if (descriptor?.startsWith("__dupout__:")) {
    const sourceFd = Number.parseInt(descriptor.slice(11), 10);
    if (!Number.isNaN(sourceFd)) {
      sink = resolveDescriptorSink(
        ctx,
        channels,
        descriptors,
        sourceFd,
        visited,
      );
    }
  }

  if (sink) {
    channels.set(fd, sink);
  }
  return sink;
}

async function installFileSink(
  ctx: InterpreterContext,
  channels: OutputChannels,
  descriptors: Map<number, string>,
  target: string,
  mode: "truncate" | "append",
  isClobber = false,
): Promise<InstalledFileSink | { error: string }> {
  if (target === "/dev/null") {
    return { sink: nullSink, descriptor: "__file__:/dev/null" };
  }
  if (target === "/dev/full") {
    return { sink: fullSink, descriptor: "__file__:/dev/full" };
  }
  if (target === "/dev/stdout" || target === "/dev/stderr") {
    const sourceFd = target === "/dev/stdout" ? 1 : 2;
    const sink = channels.get(sourceFd);
    if (!sink) {
      return { error: getBadFileDescriptorError(sourceFd) };
    }
    return {
      sink,
      descriptor: descriptors.get(sourceFd) ?? `__dupout__:${sourceFd}`,
    };
  }

  const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
  const validationError = await checkOutputRedirectTarget(
    ctx,
    filePath,
    target,
    {
      checkNoclobber: mode === "truncate",
      isClobber,
    },
  );
  if (validationError) {
    return { error: validationError };
  }

  if (mode === "truncate") {
    await ctx.fs.writeFile(filePath, "");
  } else {
    await ctx.fs.appendFile(filePath, new Uint8Array());
  }

  return {
    sink: queuedFileSink(ctx, filePath),
    descriptor:
      mode === "append"
        ? `__file_append__:${filePath}`
        : `__file__:${filePath}`,
  };
}

function setDescriptor(
  ctx: InterpreterContext,
  fd: number,
  descriptor: string,
): void {
  if (!ctx.state.fileDescriptors) {
    ctx.state.fileDescriptors = new Map();
  }
  ctx.state.fileDescriptors.set(fd, descriptor);
}

function snapshotDescriptor(
  descriptors: Map<number, string>,
  sourceFd: number,
): string {
  return descriptors.get(sourceFd) ?? `__dupout__:${sourceFd}`;
}

function mirrorDescriptor(
  ctx: InterpreterContext,
  redir: RedirectionNode,
  fd: number,
  descriptor: string,
  persistent: boolean,
): void {
  if (!persistent && !redir.fdVariable) {
    return;
  }

  // The legacy {var}>>file path records __file__ so existing >&$var command
  // handling recognizes it. Persistent exec uses the append-specific marker.
  if (redir.fdVariable && descriptor.startsWith("__file_append__:")) {
    setDescriptor(ctx, fd, `__file__:${descriptor.slice(16)}`);
    return;
  }
  setDescriptor(ctx, fd, descriptor);
}

function deleteDescriptor(
  ctx: InterpreterContext,
  redir: RedirectionNode,
  fd: number,
  persistent: boolean,
): void {
  if (persistent || redir.fdVariable) {
    ctx.state.fileDescriptors?.delete(fd);
  }
}

function compilationError(
  channels: OutputChannels,
  legacyRedirections: RedirectionNode[],
  message: string,
): CompiledOutputRedirections {
  return {
    channels,
    legacyRedirections,
    error: failure(message),
  };
}

/**
 * Compile output redirections into a fresh channel table.
 *
 * Input redirections are returned untouched for the legacy caller. The input
 * channel table is never mutated; fd duplication snapshots the sink installed
 * at that point in the left-to-right redirect sequence.
 */
export async function compileOutputRedirections(
  ctx: InterpreterContext,
  current: OutputChannels,
  redirections: RedirectionNode[],
  options: CompileOptions = {},
): Promise<CompiledOutputRedirections> {
  const channels = new Map(current);
  const descriptors = new Map(ctx.state.fileDescriptors);
  const legacyRedirections: RedirectionNode[] = [];
  const persistent = options.persistent === true;

  for (const redir of redirections) {
    if (isInputRedirection(redir)) {
      legacyRedirections.push(redir);
      continue;
    }

    const expanded = await expandRedirectionTarget(ctx, redir);
    if ("error" in expanded) {
      return compilationError(channels, legacyRedirections, expanded.error);
    }
    const target = expanded.target;
    const invalidTargetError = getInvalidRedirectTargetError(target);
    if (invalidTargetError) {
      return compilationError(channels, legacyRedirections, invalidTargetError);
    }

    if (redir.operator === ">&" && target === "-" && redir.fdVariable) {
      if (ctx.state.env.has(redir.fdVariable)) {
        const fd = Number.parseInt(envGet(ctx.state.env, redir.fdVariable), 10);
        if (!Number.isNaN(fd)) {
          channels.delete(fd);
          descriptors.delete(fd);
          deleteDescriptor(ctx, redir, fd, persistent);
        }
      }
      continue;
    }

    const fd = redir.fdVariable ? allocateFd(ctx) : (redir.fd ?? 1);
    if (redir.fdVariable) {
      envSet(ctx.state.env, redir.fdVariable, String(fd));
    }
    if (!Number.isInteger(fd) || fd < 0) {
      return compilationError(
        channels,
        legacyRedirections,
        getBadFileDescriptorError(fd),
      );
    }

    if (
      redir.operator === ">" ||
      redir.operator === ">|" ||
      redir.operator === ">>" ||
      redir.operator === "&>" ||
      redir.operator === "&>>"
    ) {
      const append = redir.operator === ">>" || redir.operator === "&>>";
      const installed = await installFileSink(
        ctx,
        channels,
        descriptors,
        target,
        append ? "append" : "truncate",
        redir.operator === ">|",
      );
      if ("error" in installed) {
        return compilationError(channels, legacyRedirections, installed.error);
      }

      if (redir.operator === "&>" || redir.operator === "&>>") {
        channels.set(1, installed.sink);
        channels.set(2, installed.sink);
        descriptors.set(1, installed.descriptor);
        descriptors.set(2, installed.descriptor);
        if (persistent) {
          setDescriptor(ctx, 1, installed.descriptor);
          setDescriptor(ctx, 2, installed.descriptor);
        }
      } else {
        channels.set(fd, installed.sink);
        descriptors.set(fd, installed.descriptor);
        mirrorDescriptor(ctx, redir, fd, installed.descriptor, persistent);
      }
      continue;
    }

    if (redir.operator !== ">&") {
      legacyRedirections.push(redir);
      continue;
    }

    if (target === "-") {
      channels.delete(fd);
      descriptors.delete(fd);
      deleteDescriptor(ctx, redir, fd, persistent);
      continue;
    }

    const moveSource = target.endsWith("-");
    const sourceText = moveSource ? target.slice(0, -1) : target;
    const normalizedSource = sourceText.startsWith("&")
      ? sourceText.slice(1)
      : sourceText;
    const sourceFd = Number.parseInt(normalizedSource, 10);
    if (!Number.isNaN(sourceFd)) {
      const sourceSink = resolveDescriptorSink(
        ctx,
        channels,
        descriptors,
        sourceFd,
      );
      if (!sourceSink) {
        return compilationError(
          channels,
          legacyRedirections,
          getBadFileDescriptorError(sourceFd),
        );
      }
      channels.set(fd, sourceSink);
      const descriptor = snapshotDescriptor(descriptors, sourceFd);
      descriptors.set(fd, descriptor);
      mirrorDescriptor(ctx, redir, fd, descriptor, persistent);
      if (moveSource) {
        channels.delete(sourceFd);
        descriptors.delete(sourceFd);
        deleteDescriptor(ctx, redir, sourceFd, persistent);
      }
      continue;
    }

    const installed = await installFileSink(
      ctx,
      channels,
      descriptors,
      target,
      "truncate",
    );
    if ("error" in installed) {
      return compilationError(channels, legacyRedirections, installed.error);
    }
    if (redir.fd == null && !redir.fdVariable) {
      channels.set(1, installed.sink);
      channels.set(2, installed.sink);
      descriptors.set(1, installed.descriptor);
      descriptors.set(2, installed.descriptor);
      if (persistent) {
        setDescriptor(ctx, 1, installed.descriptor);
        setDescriptor(ctx, 2, installed.descriptor);
      }
    } else {
      channels.set(fd, installed.sink);
      descriptors.set(fd, installed.descriptor);
      mirrorDescriptor(ctx, redir, fd, installed.descriptor, persistent);
    }
  }

  return { channels, legacyRedirections };
}

/**
 * Mutate the live channel table for a persistent `exec` output redirect.
 *
 * Phase 3 exposes this mechanism without wiring it into legacy aggregation.
 */
export async function applyPersistentOutputRedirections(
  ctx: InterpreterContext,
  redirections: RedirectionNode[],
): Promise<CompiledOutputRedirections> {
  const liveChannels = ctx.outputChannels;
  const compiled = await compileOutputRedirections(
    ctx,
    liveChannels,
    redirections,
    { persistent: true },
  );
  if (compiled.error) {
    return compiled;
  }

  liveChannels.clear();
  for (const [fd, sink] of compiled.channels) {
    liveChannels.set(fd, sink);
  }
  return { ...compiled, channels: liveChannels };
}
