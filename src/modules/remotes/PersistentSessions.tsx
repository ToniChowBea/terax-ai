import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  Delete02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  RefreshIcon,
  Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { toast } from "sonner";
import { PanelIconButton } from "./PanelIconButton";
import { askConfirm, askText } from "./lib/ask";
import {
  relativeTime,
  type TmuxSession,
  usePersistentSessions,
  validateSessionName,
} from "./lib/tmux";

/**
 * Fork-only (SSH port): "Persistent sessions", the tmux sessions on a host.
 * List, attach (focusing a tab already attached), create, rename, kill and
 * detach. Uses the host's shared connection, so it never prompts.
 */
export function PersistentSessions({
  profileId,
  attachedTabs,
  onAttach,
}: {
  profileId: string;
  /** tmux session ids that already have a Terax tab on this host. */
  attachedTabs: ReadonlySet<string>;
  /** Focus the tab attached to `id`, or open one, labelled `name`. */
  onAttach: (profileId: string, id: string, name: string) => void;
}) {
  const state = usePersistentSessions((s) => s.byHost[profileId]);
  const store = usePersistentSessions.getState;

  useEffect(() => {
    void usePersistentSessions.getState().refresh(profileId);
  }, [profileId]);

  const report = (label: string) => (e: unknown) =>
    toast.error(label, {
      description: e instanceof Error ? e.message : String(e),
    });

  const createSession = async () => {
    const name = await askText({
      title: "New persistent session",
      description:
        "A tmux session on the host. It keeps running after you disconnect.",
      label: "Session name",
      confirmLabel: "Create and attach",
      validate: validateSessionName,
    });
    if (name === null) return;
    try {
      const id = await store().create(profileId, name);
      onAttach(profileId, id, name);
    } catch (e) {
      report("Could not create the session")(e);
    }
  };

  const renameSession = async (s: TmuxSession) => {
    const next = await askText({
      title: "Rename persistent session",
      label: "Session name",
      initial: s.name,
      confirmLabel: "Rename",
      validate: validateSessionName,
    });
    if (next === null || next === s.name) return;
    await store()
      .rename(profileId, s.id, next)
      .catch(report("Could not rename the session"));
  };

  const killSession = async (s: TmuxSession) => {
    const ok = await askConfirm({
      title: `Kill "${s.name}"?`,
      description:
        "Everything running in this tmux session will be stopped. This cannot be undone.",
      confirmLabel: "Kill session",
      destructive: true,
    });
    if (!ok) return;
    await store()
      .kill(profileId, s.id)
      .catch(report("Could not kill the session"));
  };

  const detachSession = async (s: TmuxSession) => {
    await store()
      .detach(profileId, s.id)
      .catch(report("Could not detach"));
  };

  if (state?.notInstalled) {
    return (
      <Note text="tmux is not installed on this host. Install it (for example `sudo apt install tmux`) to keep sessions running after you disconnect." />
    );
  }

  const sessions = state?.sessions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-0.5 px-1.5 py-1">
        <PanelIconButton
          label="New persistent session"
          icon={PlusSignIcon}
          onClick={() => void createSession()}
        />
        <PanelIconButton
          label="Refresh"
          icon={RefreshIcon}
          onClick={() => void store().refresh(profileId)}
        />
      </div>
      {state?.error ? (
        <p className="px-2.5 py-1 text-[11px] text-destructive">
          {state.error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!state || (state.loading && sessions.length === 0) ? (
          <Note text="Loading" />
        ) : sessions.length === 0 ? (
          <Note text="No persistent sessions. Create one to keep work running on the host after you disconnect." />
        ) : (
          sessions.map((s) => (
            <Row
              key={s.id}
              session={s}
              hasTab={attachedTabs.has(s.id)}
              onOpen={() => onAttach(profileId, s.id, s.name)}
              onRename={() => void renameSession(s)}
              onKill={() => void killSession(s)}
              onDetach={() => void detachSession(s)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Row({
  session,
  hasTab,
  onOpen,
  onRename,
  onKill,
  onDetach,
}: {
  session: TmuxSession;
  hasTab: boolean;
  onOpen: () => void;
  onRename: () => void;
  onKill: () => void;
  onDetach: () => void;
}) {
  const attached = session.attached > 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            // On macOS a ctrl+click is a secondary click: it opens the menu
            // (Kill, Detach...). WebKit still delivers a primary `click`
            // for it, which must not also attach the session and re-mark it
            // "attached" on the next refresh.
            if (e.ctrlKey || e.button !== 0) return;
            onOpen();
          }}
          title={`Created ${new Date(session.created * 1000).toLocaleString()}`}
          className={cn(
            "flex w-full items-center gap-2 px-2.5 py-[4px] text-left transition-colors",
            "hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.06] focus-visible:outline-none",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              attached ? "bg-emerald-500" : "bg-muted-foreground/50",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
            {session.name}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {session.windows}w · {attached ? "attached" : "detached"} ·{" "}
            {relativeTime(session.activity)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onOpen}>
          {hasTab ? "Go to tab" : "Attach in new tab"}
        </ContextMenuItem>
        {attached ? (
          <ContextMenuItem onSelect={onDetach}>
            <HugeiconsIcon icon={Unlink01Icon} size={13} />
            Detach
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRename}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={13} />
          Rename
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={onKill}>
          <HugeiconsIcon icon={Delete02Icon} size={13} />
          Kill session
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Note({ text }: { text: string }) {
  return (
    <p className="px-3 py-3 text-[11px] text-muted-foreground">{text}</p>
  );
}
