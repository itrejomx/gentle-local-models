// Thin pass-through wrapper over ctx.ui.notify (Phase 6). No business logic:
// the shell decides the message, the type, and when to call it.

export interface NotifyPort {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Pass-through to ctx.ui.notify. */
export function notify(ui: NotifyPort, message: string, type?: "info" | "warning" | "error"): void {
  ui.notify(message, type);
}
