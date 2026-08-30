// Phase 6 — ui/*.ts are thin pass-through wrappers over ctx.ui. Every test
// here proves pass-through behavior against a mocked ctx.ui-shaped port; no
// business logic lives in these wrappers (that stays in the shell, Phase 7/8).

import { describe, expect, it, vi } from "vitest";
import { selectFromList } from "../extensions/local-models/ui/select-list.ts";
import { toggleSetting, editSetting } from "../extensions/local-models/ui/settings-list.ts";
import { withLoader } from "../extensions/local-models/ui/bordered-loader.ts";
import { promptWithPrefill } from "../extensions/local-models/ui/prompt.ts";
import { notify } from "../extensions/local-models/ui/notify.ts";

describe("selectFromList — thin pass-through to ctx.ui.select", () => {
  it("forwards title/options and returns the selection unchanged", async () => {
    const select = vi.fn(async () => "mlx-serve");

    const result = await selectFromList({ select }, "Server kind", ["mlx-serve", "llama-swap"]);

    expect(select).toHaveBeenCalledWith("Server kind", ["mlx-serve", "llama-swap"]);
    expect(result).toBe("mlx-serve");
  });

  it("passes a cancelled selection through as undefined", async () => {
    const select = vi.fn(async () => undefined);

    const result = await selectFromList({ select }, "Server kind", ["mlx-serve", "llama-swap"]);

    expect(result).toBeUndefined();
  });
});

describe("toggleSetting — thin pass-through to ctx.ui.confirm", () => {
  it("forwards title/message and returns the boolean unchanged", async () => {
    const confirm = vi.fn(async () => true);

    const result = await toggleSetting({ confirm }, "Prune?", "Remove 3 Unserved Models");

    expect(confirm).toHaveBeenCalledWith("Prune?", "Remove 3 Unserved Models");
    expect(result).toBe(true);
  });

  it("passes a declined confirmation through as false", async () => {
    const confirm = vi.fn(async () => false);

    const result = await toggleSetting({ confirm }, "Prune?", "Remove 3 Unserved Models");

    expect(result).toBe(false);
  });
});

describe("editSetting — thin pass-through to ctx.ui.editor", () => {
  it("forwards the current value as the editor prefill and returns the edit unchanged", async () => {
    const editor = vi.fn(async () => "deepseek");

    const result = await editSetting({ editor }, "thinkingFormat", "qwen");

    expect(editor).toHaveBeenCalledWith("thinkingFormat", "qwen");
    expect(result).toBe("deepseek");
  });

  it("passes an editor cancellation through as undefined", async () => {
    const editor = vi.fn(async () => undefined);

    const result = await editSetting({ editor }, "thinkingFormat", "qwen");

    expect(result).toBeUndefined();
  });
});

describe("withLoader — thin bracket around an async fn", () => {
  it("shows the working indicator during fn and restores it after, returning fn's result unchanged", async () => {
    const calls: string[] = [];
    const ui = {
      setWorkingMessage: vi.fn((message?: string) => calls.push(`message:${message ?? ""}`)),
      setWorkingVisible: vi.fn((visible: boolean) => calls.push(`visible:${visible}`)),
    };

    const result = await withLoader(ui, "Probing servers…", async () => {
      calls.push("fn");
      return 42;
    });

    expect(result).toBe(42);
    expect(calls).toEqual([
      "message:Probing servers…",
      "visible:true",
      "fn",
      "visible:false",
      "message:",
    ]);
  });

  it("still restores the working indicator and rethrows when fn fails", async () => {
    const ui = {
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
    };
    const failure = new Error("probe failed");

    await expect(
      withLoader(ui, "Probing servers…", async () => {
        throw failure;
      }),
    ).rejects.toThrow(failure);

    expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(false);
    expect(ui.setWorkingMessage).toHaveBeenLastCalledWith();
  });
});

describe("promptWithPrefill — D5: ctx.ui.editor, never ctx.ui.input", () => {
  it("calls ctx.ui.editor with the prefill and returns the accepted value unchanged", async () => {
    const editor = vi.fn(async () => "32768");

    const result = await promptWithPrefill({ hasUI: true, ui: { editor } }, "contextWindow", "32768");

    expect(editor).toHaveBeenCalledWith("contextWindow", "32768");
    expect(result).toBe("32768");
  });

  it("returns undefined on editor cancellation", async () => {
    const editor = vi.fn(async () => undefined);

    const result = await promptWithPrefill({ hasUI: true, ui: { editor } }, "contextWindow", "32768");

    expect(result).toBeUndefined();
  });

  it("skips the dialog entirely and returns undefined when ctx.hasUI is false", async () => {
    const editor = vi.fn(async () => "32768");

    const result = await promptWithPrefill({ hasUI: false, ui: { editor } }, "contextWindow", "32768");

    expect(editor).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe("notify — thin pass-through to ctx.ui.notify", () => {
  it("forwards the message and type unchanged", () => {
    const notifyPort = vi.fn();

    notify({ notify: notifyPort }, "3 models are placeholder-labeled", "warning");

    expect(notifyPort).toHaveBeenCalledWith("3 models are placeholder-labeled", "warning");
  });

  it("forwards a message with no type", () => {
    const notifyPort = vi.fn();

    notify({ notify: notifyPort }, "Registered lmstudio");

    expect(notifyPort).toHaveBeenCalledWith("Registered lmstudio", undefined);
  });
});
