// Thin pass-through wrapper over ctx.ui.select (Phase 6). No business logic:
// the shell decides the title, the options, and what to do with the result.

export interface SelectListPort {
  select(title: string, options: string[]): Promise<string | undefined>;
}

/** Pass-through to ctx.ui.select — returns the user's choice unchanged. */
export function selectFromList(
  ui: SelectListPort,
  title: string,
  options: string[],
): Promise<string | undefined> {
  return ui.select(title, options);
}
