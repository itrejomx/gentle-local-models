// Thin bracket around an async fn (Phase 6): shows ctx.ui's working
// indicator while fn runs and always restores it afterward, success or
// failure. No business logic — the message and the fn are the shell's.

export interface LoaderPort {
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
}

/**
 * Runs `fn` with ctx.ui's working indicator shown, restoring it (hidden,
 * message cleared) in a `finally` regardless of whether `fn` resolves or
 * rejects. Returns/rethrows `fn`'s outcome unchanged.
 */
export async function withLoader<T>(ui: LoaderPort, message: string, fn: () => Promise<T>): Promise<T> {
  ui.setWorkingMessage(message);
  ui.setWorkingVisible(true);
  try {
    return await fn();
  } finally {
    ui.setWorkingVisible(false);
    ui.setWorkingMessage();
  }
}
