/**
 * AbortSignal composition utility.
 *
 * Used to inherit a parent execution's signal into nested exec calls
 * (bash -c, xargs, timeout, command substitution via execFn) while still
 * allowing the nested call to carry its own signal.
 */

/**
 * Combine two optional AbortSignals into one that aborts when either does.
 * Returns the other signal unchanged when only one is provided.
 */
export function combineAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([a, b]);
  }
  // Fallback for runtimes without AbortSignal.any
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => () =>
    controller.abort(signal.reason);
  if (a.aborted) {
    controller.abort(a.reason);
  } else if (b.aborted) {
    controller.abort(b.reason);
  } else {
    a.addEventListener("abort", forward(a), { once: true });
    b.addEventListener("abort", forward(b), { once: true });
  }
  return controller.signal;
}
