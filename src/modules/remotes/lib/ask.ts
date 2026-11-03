import { create } from "zustand";

/**
 * Fork-only (SSH port): in-app replacements for `window.confirm` and
 * `window.prompt`.
 *
 * The native ones do not work in Terax: on macOS, wry's WKWebView UI
 * delegate implements no JavaScript panel callbacks, so WebKit returns
 * `false` from `confirm` and `null` from `prompt` immediately and nothing is
 * shown. Every Kill, Delete, Rename and New in the remotes UI silently did
 * nothing because of it. These resolve when the user answers an
 * `AskDialogHost` dialog instead.
 */
export type AskRequest =
  | {
      kind: "confirm";
      title: string;
      description?: string;
      confirmLabel: string;
      destructive: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      kind: "text";
      title: string;
      description?: string;
      label: string;
      initial: string;
      confirmLabel: string;
      /** Returns an error message to show, or null when the value is fine. */
      validate?: (value: string) => string | null;
      resolve: (value: string | null) => void;
    };

type State = {
  current: AskRequest | null;
  queue: AskRequest[];
  open: (req: AskRequest) => void;
  /** Answer the dialog on screen and move to the next one. */
  settle: () => void;
};

export const useAskStore = create<State>((set, get) => ({
  current: null,
  queue: [],
  open: (req) =>
    set((s) =>
      s.current ? { queue: [...s.queue, req] } : { current: req },
    ),
  settle: () => {
    const [next, ...rest] = get().queue;
    set({ current: next ?? null, queue: rest });
  },
}));

export function askConfirm(opts: {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) =>
    useAskStore.getState().open({
      kind: "confirm",
      title: opts.title,
      description: opts.description,
      confirmLabel: opts.confirmLabel ?? "OK",
      destructive: opts.destructive ?? false,
      resolve,
    }),
  );
}

/** Resolves to the trimmed text, or null when cancelled. */
export function askText(opts: {
  title: string;
  description?: string;
  label?: string;
  initial?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) =>
    useAskStore.getState().open({
      kind: "text",
      title: opts.title,
      description: opts.description,
      label: opts.label ?? "Name",
      initial: opts.initial ?? "",
      confirmLabel: opts.confirmLabel ?? "OK",
      validate: opts.validate,
      resolve,
    }),
  );
}

/** Generic name check for files and folders created or renamed remotely. */
export function validateEntryName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "A name cannot be empty.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (name.includes("/")) return "A name cannot contain '/'.";
  if (name.includes("\0")) return "A name cannot contain a NUL byte.";
  return null;
}
