// Thin pass-through wrappers for settings-style toggle/edit (Phase 6).
// ExtensionUIContext has no dedicated "settings list" primitive, so a toggle
// maps onto ctx.ui.confirm and an edit maps onto ctx.ui.editor (which, unlike
// ctx.ui.input, actually seeds prefill text — see prompt.ts's D5 note). No
// business logic: what gets toggled/edited and what happens with the result
// is the shell's job.

export interface SettingsListPort {
  confirm(title: string, message: string): Promise<boolean>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
}

/** Pass-through to ctx.ui.confirm — a settings-style boolean toggle. */
export function toggleSetting(
  ui: Pick<SettingsListPort, "confirm">,
  title: string,
  message: string,
): Promise<boolean> {
  return ui.confirm(title, message);
}

/** Pass-through to ctx.ui.editor, prefilled with the current value — a settings-style edit. */
export function editSetting(
  ui: Pick<SettingsListPort, "editor">,
  title: string,
  currentValue: string,
): Promise<string | undefined> {
  return ui.editor(title, currentValue);
}
