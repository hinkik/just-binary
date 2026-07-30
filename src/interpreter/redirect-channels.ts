import type { RedirectionNode, WordNode } from "../ast/types.js";
import type { ExecResult } from "../types.js";
import { envGet, envSet } from "../utils/bytes.js";
import { failure } from "./helpers/result.js";
import {
  CLOSED_CHANNEL_DESCRIPTOR,
  copyChannelDescriptors,
  deletePersistentChannel,
  hasChannelBinding,
  markTemporaryChannelOverride,
  type OutputChannels,
  type OutputSink,
  setPersistentChannel,
  trackChannelDescriptors,
  trackTemporaryChannelParent,
} from "./output-channels.js";
import {
  allocateFd,
  checkOutputRedirectTarget,
  expandRedirectionTarget,
  getBadFileDescriptorError,
  getInvalidRedirectTargetError,
  processFdVariableRedirections,
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
  inputRedirectionsProcessed?: boolean;
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
    redir.operator === "<>" ||
    redir.operator === "<<<" ||
    redir.operator === "<<" ||
    redir.operator === "<<-"
  );
}

function withExpandedTarget(
  redir: RedirectionNode,
  target: string,
): RedirectionNode {
  const expandedWord: WordNode = {
    type: "Word",
    parts: [{ type: "Literal", value: target }],
  };
  return { ...redir, target: expandedWord };
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
  activeDescriptor: string | undefined,
  reachedOwningTable = true,
): void {
  const storedDescriptor = ctx.state.fileDescriptors?.get(fd);
  const normalizedActiveDescriptor = activeDescriptor?.startsWith(
    "__file_append__:",
  )
    ? `__file__:${activeDescriptor.slice(16)}`
    : activeDescriptor;
  if (
    (persistent || redir.fdVariable) &&
    reachedOwningTable &&
    storedDescriptor !== undefined &&
    storedDescriptor === normalizedActiveDescriptor
  ) {
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
 * Ordinary input redirections are returned for the legacy caller. FD-variable
 * input redirections are processed inline so descriptor allocation preserves
 * source order. The input channel table is not mutated except when a persistent
 * brace-FD close/move intentionally reaches through temporary compiler tables;
 * fd duplication snapshots the sink installed at that point in the
 * left-to-right redirect sequence.
 */
export async function compileOutputRedirections(
  ctx: InterpreterContext,
  current: OutputChannels,
  redirections: RedirectionNode[],
  options: CompileOptions = {},
): Promise<CompiledOutputRedirections> {
  const channels = new Map(current);
  const descriptors = new Map(ctx.state.fileDescriptors);
  for (const [fd, descriptor] of copyChannelDescriptors(current)) {
    descriptors.set(fd, descriptor);
  }
  trackChannelDescriptors(channels, descriptors);
  trackTemporaryChannelParent(channels, current);
  const legacyRedirections: RedirectionNode[] = [];
  const persistent = options.persistent === true;

  for (const redir of redirections) {
    if (
      options.inputRedirectionsProcessed &&
      redir.operator === "<&" &&
      !redir.fdVariable &&
      (redir.fd ?? 0) === 0
    ) {
      legacyRedirections.push(redir);
      continue;
    }

    let preExpandedTarget: string | undefined;
    if (redir.operator === "<&" && redir.target.type === "Word") {
      const expanded = await expandRedirectionTarget(ctx, redir);
      if ("error" in expanded) {
        return compilationError(channels, legacyRedirections, expanded.error);
      }
      preExpandedTarget = expanded.target;
      const normalizedSource = preExpandedTarget.startsWith("&")
        ? preExpandedTarget.slice(1)
        : preExpandedTarget;
      const numericSource = /^\d+-?$/.test(normalizedSource);
      if (preExpandedTarget !== "-" && !numericSource) {
        return compilationError(
          channels,
          legacyRedirections,
          `bash: ${preExpandedTarget}: ambiguous redirect\n`,
        );
      }

      // Replacing fd 0 remains on the input path. Preserve the already
      // expanded target so arithmetic/command substitutions run once.
      if (!redir.fdVariable && (redir.fd ?? 0) === 0) {
        legacyRedirections.push(withExpandedTarget(redir, preExpandedTarget));
        continue;
      }
    }

    if (isInputRedirection(redir)) {
      if (redir.fdVariable && redir.target.type === "Word") {
        const fdVarError = await processFdVariableRedirections(
          ctx,
          [redir],
          (fd) => descriptors.has(fd) || hasChannelBinding(channels, fd),
        );
        if (fdVarError) {
          return {
            channels,
            legacyRedirections,
            error: fdVarError,
          };
        }
        const fd = Number.parseInt(envGet(ctx.state.env, redir.fdVariable), 10);
        const descriptor = ctx.state.fileDescriptors?.get(fd);
        if (!Number.isNaN(fd) && descriptor !== undefined) {
          descriptors.set(fd, descriptor);
        }
      } else {
        legacyRedirections.push(redir);
      }
      continue;
    }

    let target: string;
    if (preExpandedTarget !== undefined) {
      target = preExpandedTarget;
    } else {
      const expanded = await expandRedirectionTarget(ctx, redir);
      if ("error" in expanded) {
        return compilationError(channels, legacyRedirections, expanded.error);
      }
      target = expanded.target;
    }
    const invalidTargetError = getInvalidRedirectTargetError(target);
    if (invalidTargetError) {
      return compilationError(channels, legacyRedirections, invalidTargetError);
    }

    if (
      (redir.operator === ">&" || redir.operator === "<&") &&
      target === "-" &&
      redir.fdVariable
    ) {
      if (ctx.state.env.has(redir.fdVariable)) {
        const fd = Number.parseInt(envGet(ctx.state.env, redir.fdVariable), 10);
        if (!Number.isNaN(fd)) {
          const activeDescriptor = descriptors.get(fd);
          const reachedOwningTable = deletePersistentChannel(channels, fd);
          deleteDescriptor(
            ctx,
            redir,
            fd,
            persistent,
            activeDescriptor,
            reachedOwningTable,
          );
        }
      }
      continue;
    }

    const fd = redir.fdVariable
      ? allocateFd(
          ctx,
          (candidate) =>
            descriptors.has(candidate) ||
            hasChannelBinding(channels, candidate),
        )
      : (redir.fd ?? (redir.operator === "<&" ? 0 : 1));
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
        markTemporaryChannelOverride(channels, 1);
        markTemporaryChannelOverride(channels, 2);
        if (persistent) {
          setDescriptor(ctx, 1, installed.descriptor);
          setDescriptor(ctx, 2, installed.descriptor);
        }
      } else {
        if (redir.fdVariable) {
          setPersistentChannel(
            channels,
            fd,
            installed.sink,
            installed.descriptor,
          );
        } else {
          channels.set(fd, installed.sink);
          descriptors.set(fd, installed.descriptor);
          markTemporaryChannelOverride(channels, fd);
        }
        mirrorDescriptor(ctx, redir, fd, installed.descriptor, persistent);
      }
      continue;
    }

    if (redir.operator !== ">&" && redir.operator !== "<&") {
      legacyRedirections.push(redir);
      continue;
    }

    if (target === "-") {
      const activeDescriptor = descriptors.get(fd);
      markTemporaryChannelOverride(channels, fd);
      channels.delete(fd);
      descriptors.set(fd, CLOSED_CHANNEL_DESCRIPTOR);
      deleteDescriptor(ctx, redir, fd, persistent, activeDescriptor);
      continue;
    }

    const moveSource = target.endsWith("-");
    const sourceText = moveSource ? target.slice(0, -1) : target;
    const normalizedSource = sourceText.startsWith("&")
      ? sourceText.slice(1)
      : sourceText;
    const sourceFd = /^\d+$/.test(normalizedSource)
      ? Number.parseInt(normalizedSource, 10)
      : Number.NaN;
    if (!Number.isNaN(sourceFd)) {
      const sourceSink = resolveDescriptorSink(
        ctx,
        channels,
        descriptors,
        sourceFd,
      );
      if (!sourceSink) {
        const sourceDescriptor = descriptors.get(sourceFd);
        if (sourceDescriptor === CLOSED_CHANNEL_DESCRIPTOR) {
          return compilationError(
            channels,
            legacyRedirections,
            getBadFileDescriptorError(sourceFd),
          );
        }
        if (redir.operator === "<&" && redir.fdVariable) {
          if (sourceDescriptor !== undefined) {
            descriptors.set(fd, sourceDescriptor);
            setDescriptor(ctx, fd, sourceDescriptor);
            if (moveSource) {
              const reachedOwningTable = deletePersistentChannel(
                channels,
                sourceFd,
              );
              deleteDescriptor(
                ctx,
                redir,
                sourceFd,
                persistent,
                sourceDescriptor,
                reachedOwningTable,
              );
            }
            continue;
          }
        }
        if (redir.operator === "<&" && !redir.fdVariable) {
          legacyRedirections.push(withExpandedTarget(redir, target));
          continue;
        }
        return compilationError(
          channels,
          legacyRedirections,
          getBadFileDescriptorError(sourceFd),
        );
      }
      const descriptor = snapshotDescriptor(descriptors, sourceFd);
      if (redir.fdVariable) {
        setPersistentChannel(channels, fd, sourceSink, descriptor);
      } else {
        channels.set(fd, sourceSink);
        descriptors.set(fd, descriptor);
      }
      mirrorDescriptor(ctx, redir, fd, descriptor, persistent);
      if (moveSource) {
        let reachedOwningTable = true;
        if (redir.fdVariable) {
          reachedOwningTable = deletePersistentChannel(channels, sourceFd);
        } else {
          markTemporaryChannelOverride(channels, sourceFd);
          channels.delete(sourceFd);
          descriptors.set(sourceFd, CLOSED_CHANNEL_DESCRIPTOR);
        }
        deleteDescriptor(
          ctx,
          redir,
          sourceFd,
          persistent,
          descriptor,
          reachedOwningTable,
        );
      }
      if (!redir.fdVariable) {
        markTemporaryChannelOverride(channels, fd);
      }
      continue;
    }

    if (redir.operator === "<&") {
      return compilationError(
        channels,
        legacyRedirections,
        `bash: ${target}: ambiguous redirect\n`,
      );
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
      markTemporaryChannelOverride(channels, 1);
      markTemporaryChannelOverride(channels, 2);
      if (persistent) {
        setDescriptor(ctx, 1, installed.descriptor);
        setDescriptor(ctx, 2, installed.descriptor);
      }
    } else {
      if (redir.fdVariable) {
        setPersistentChannel(
          channels,
          fd,
          installed.sink,
          installed.descriptor,
        );
      } else {
        channels.set(fd, installed.sink);
        descriptors.set(fd, installed.descriptor);
        markTemporaryChannelOverride(channels, fd);
      }
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
  trackChannelDescriptors(
    liveChannels,
    copyChannelDescriptors(compiled.channels),
  );
  return { ...compiled, channels: liveChannels };
}
