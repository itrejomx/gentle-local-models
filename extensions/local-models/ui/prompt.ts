// D5 — pre-filled prompts MUST use ctx.ui.editor, never ctx.ui.input.
// Evidence: Pi's interactive Input component takes a placeholder argument
// but never passes it to `new Input()` (extension-input.js), so it cannot
// pre-fill; ctx.ui.editor seeds real editable text (interactive-mode.js,
// runner.js:279). This wrapper is thin: it only adds the `!ctx.hasUI` guard
// (no dialog-capable UI ⇒ skip the dialog outright) and passes an editor
// cancellation through as `undefined`, unchanged. What a `placeholder` vs.
// `declarado` label means for either case is the shell's decision (Phase 7).

export interface PromptContext {
  hasUI: boolean;
  ui: {
    editor(title: string, prefill?: string): Promise<string | undefined>;
  };
}

/**
 * Prompts for a value pre-filled with `prefill` via ctx.ui.editor. Returns
 * `undefined` without opening a dialog when `ctx.hasUI` is false, and passes
 * an editor cancellation through as `undefined` as well — both cases are
 * indistinguishable here by design; the shell decides what each means.
 */
export async function promptWithPrefill(
  ctx: PromptContext,
  title: string,
  prefill: string,
): Promise<string | undefined> {
  if (!ctx.hasUI) {
    return undefined;
  }
  return ctx.ui.editor(title, prefill);
}
