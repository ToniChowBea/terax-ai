import { PanelIconButton } from "./PanelIconButton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { quoteShellArg } from "@/lib/shellQuote";
import type { RemoteIconSet } from "@/modules/settings/store";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  CommandLineIcon,
  Copy01Icon,
  Delete02Icon,
  Download04Icon,
  File01Icon,
  Folder01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  RefreshIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  browserEnv,
  type DirState,
  flattenTree,
  joinRemote,
  parentRemote,
  type TreeRow,
  useRemoteBrowserStore,
} from "./lib/browser";
import { askConfirm, askText, validateEntryName } from "./lib/ask";
import {
  iconSetsVersion,
  loadIconSet,
  remoteFileIconUrl,
  remoteFolderIconUrl,
  subscribeIconSets,
} from "./lib/icons";

export function RemoteFiles({
  onRunInTerminal,
  onOpenFile,
}: {
  /** Send a line to the active terminal; only for the explicit "cd here". */
  onRunInTerminal?: (line: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const conn = useRemoteBrowserStore((s) => s.conn);
  const cwd = useRemoteBrowserStore((s) => s.cwd);
  const dirs = useRemoteBrowserStore((s) => s.dirs);
  const expanded = useRemoteBrowserStore((s) => s.expanded);
  const connecting = useRemoteBrowserStore((s) => s.connecting);
  const error = useRemoteBrowserStore((s) => s.error);
  const showHidden = useRemoteBrowserStore((s) => s.showHidden);
  const iconSet = usePreferencesStore((s) => s.remoteIconSet);
  const store = useRemoteBrowserStore.getState;

  useEffect(() => loadIconSet(iconSet), [iconSet]);
  // The URLs change the moment a set finishes arriving, so the rows have to be
  // told; the set itself is module state rather than a store.
  useSyncExternalStore(subscribeIconSets, iconSetsVersion);

  const rows = useMemo(
    () => flattenTree(cwd, dirs, expanded),
    [cwd, dirs, expanded],
  );
  const rootState = dirs[cwd];
  const up = parentRemote(cwd);

  /** Run a mutation inside `dir`, then reload just that directory. */
  const act = async (
    label: string,
    dir: string,
    fn: () => Promise<unknown>,
  ) => {
    try {
      await store().authorize(dir);
      await fn();
      await store().reload(dir);
    } catch (e) {
      toast.error(label, { description: String(e) });
    }
  };

  const createEntry = async (kind: "file" | "dir", dir: string) => {
    const name = await askText({
      title: kind === "dir" ? "New folder" : "New file",
      description: `In ${dir}`,
      label: "Name",
      confirmLabel: "Create",
      validate: validateEntryName,
    });
    if (name === null) return;
    const env = browserEnv();
    if (!env) return;
    const path = joinRemote(dir, name);
    await act(`Could not create ${name}`, dir, async () => {
      await invoke(kind === "dir" ? "fs_create_dir" : "fs_create_file", {
        path,
        workspace: env,
      });
      if (dir !== cwd && !store().expanded.has(dir)) await store().toggle(dir);
    });
  };

  if (connecting) {
    return <Placeholder text="Connecting" />;
  }
  if (conn === null) {
    return <Placeholder text="Open a host to browse its files" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-0.5 px-1.5 py-1">
        <PanelIconButton
          label="Up one level"
          icon={ArrowUp01Icon}
          disabled={!up}
          onClick={() => {
            // Re-roots the tree only; the terminal stays where it is.
            if (up) void store().navigate(up);
          }}
        />
        <PanelIconButton
          label="New file"
          icon={PlusSignIcon}
          onClick={() => void createEntry("file", cwd)}
        />
        <PanelIconButton
          label="New folder"
          icon={Folder01Icon}
          onClick={() => void createEntry("dir", cwd)}
        />
        <PanelIconButton
          label={showHidden ? "Hide hidden files" : "Show hidden files"}
          icon={showHidden ? ViewIcon : ViewOffSlashIcon}
          onClick={() => store().setShowHidden(!showHidden)}
        />
        <PanelIconButton
          label="Refresh"
          icon={RefreshIcon}
          onClick={() => void store().refresh()}
        />
      </div>

      <div
        className="truncate px-2.5 pb-1 text-[10.5px] text-muted-foreground/85"
        title={cwd}
      >
        {cwd}
      </div>

      {error ? (
        <p className="px-2.5 py-2 text-[11px] text-destructive">{error}</p>
      ) : rootState?.status === "error" ? (
        <p className="px-2.5 py-2 text-[11px] text-destructive">
          {rootState.message}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pb-2" role="tree">
        {!rootState || rootState.status === "loading" ? (
          <Placeholder text="Loading" />
        ) : rows.length === 0 && rootState.status === "loaded" ? (
          <Placeholder text="Empty" />
        ) : (
          rows.map((row) => (
            <Row
              key={row.path}
              row={row}
              dirState={dirs[row.path]}
              iconSet={iconSet}
              onRunInTerminal={onRunInTerminal}
              onOpenFile={onOpenFile}
              onCreate={createEntry}
              onAct={act}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Row({
  row,
  dirState,
  iconSet,
  onRunInTerminal,
  onOpenFile,
  onCreate,
  onAct,
}: {
  row: TreeRow;
  dirState: DirState | undefined;
  iconSet: RemoteIconSet;
  onRunInTerminal?: (line: string) => void;
  onOpenFile?: (path: string) => void;
  onCreate: (kind: "file" | "dir", dir: string) => Promise<void>;
  onAct: (
    label: string,
    dir: string,
    fn: () => Promise<unknown>,
  ) => Promise<void>;
}) {
  const { path, entry, depth, expanded } = row;
  const isDir = entry.kind === "dir";
  const parent = parentRemote(path) ?? "/";
  const iconUrl = isDir
    ? remoteFolderIconUrl(iconSet, entry.name)
    : remoteFileIconUrl(iconSet, entry.name);
  const store = useRemoteBrowserStore.getState;

  // Clicking browses; it never types into the terminal. Moving the terminal
  // is the explicit "cd here" below.
  const activate = () => {
    if (isDir) void store().toggle(path);
    else onOpenFile?.(path);
  };
  const cd = () => onRunInTerminal?.(`cd ${quoteShellArg(path, false)}`);

  const rename = async () => {
    const next = await askText({
      title: `Rename ${entry.name}`,
      label: "New name",
      initial: entry.name,
      confirmLabel: "Rename",
      validate: validateEntryName,
    });
    if (next === null || next === entry.name) return;
    const env = browserEnv();
    if (!env) return;
    await onAct(`Could not rename ${entry.name}`, parent, () =>
      invoke("fs_rename", {
        from: path,
        to: joinRemote(parent, next),
        workspace: env,
      }),
    );
  };

  const remove = async () => {
    const ok = await askConfirm({
      title: `Delete ${entry.name}?`,
      description: isDir
        ? "The folder and everything in it will be deleted on the host. This cannot be undone."
        : "The file will be deleted on the host. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const env = browserEnv();
    if (!env) return;
    await onAct(`Could not delete ${entry.name}`, parent, () =>
      invoke("fs_delete", { path, workspace: env }),
    );
  };

  const download = () => {
    const { conn } = store();
    if (conn === null) return;
    void (async () => {
      try {
        const saved = await invoke<string>("remote_download", { conn, path });
        toast.success(`Downloaded ${entry.name}`, { description: saved });
      } catch (e) {
        toast.error(`Could not download ${entry.name}`, {
          description: String(e),
        });
      }
    })();
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            role="treeitem"
            aria-expanded={isDir ? expanded : undefined}
            onClick={(e) => {
              // ctrl+click on macOS is the context menu, not an activation.
              if (e.ctrlKey || e.button !== 0) return;
              activate();
            }}
            onKeyDown={(e) => {
              if (!isDir) return;
              if (e.key === "ArrowRight" && !expanded) void store().toggle(path);
              if (e.key === "ArrowLeft" && expanded) void store().toggle(path);
            }}
            style={{ paddingLeft: 6 + depth * 12 }}
            className={cn(
              "flex w-full items-center gap-1 py-[3px] pr-2.5 text-left transition-colors",
              "hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.06] focus-visible:outline-none",
            )}
          >
            <HugeiconsIcon
              icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
              size={11}
              strokeWidth={2}
              className={cn(
                "shrink-0 text-muted-foreground/70",
                !isDir && "invisible",
              )}
            />
            {iconUrl ? (
              <img
                src={iconUrl}
                alt=""
                draggable={false}
                className="size-[14px] shrink-0"
              />
            ) : (
              <HugeiconsIcon
                icon={isDir ? Folder01Icon : File01Icon}
                size={13}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground"
              />
            )}
            <span className="ml-1 truncate text-[11.5px] leading-tight text-foreground">
              {entry.name}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {isDir ? (
            <>
              <ContextMenuItem onSelect={() => void store().toggle(path)}>
                {expanded ? "Collapse" : "Expand"}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void store().navigate(path)}>
                Show only this folder
              </ContextMenuItem>
              {onRunInTerminal ? (
                <ContextMenuItem onSelect={cd}>
                  <HugeiconsIcon icon={CommandLineIcon} size={13} />
                  cd here in terminal
                </ContextMenuItem>
              ) : null}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void onCreate("file", path)}>
                New file here
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void onCreate("dir", path)}>
                New folder here
              </ContextMenuItem>
            </>
          ) : (
            <>
              {onOpenFile ? (
                <ContextMenuItem onSelect={() => onOpenFile(path)}>
                  Open in editor
                </ContextMenuItem>
              ) : null}
              {onRunInTerminal ? (
                <ContextMenuItem
                  onSelect={() =>
                    onRunInTerminal(
                      `\${EDITOR:-vi} ${quoteShellArg(path, false)}`,
                    )
                  }
                >
                  Open in terminal editor
                </ContextMenuItem>
              ) : null}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={download}>
                <HugeiconsIcon icon={Download04Icon} size={13} />
                Download
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void rename()}>
            <HugeiconsIcon icon={PencilEdit02Icon} size={13} />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => void navigator.clipboard.writeText(path)}
          >
            <HugeiconsIcon icon={Copy01Icon} size={13} />
            Copy path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => void remove()}>
            <HugeiconsIcon icon={Delete02Icon} size={13} />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && dirState?.status === "loading" ? (
        <p
          className="py-[3px] text-[11px] text-muted-foreground"
          style={{ paddingLeft: 30 + (depth + 1) * 12 }}
        >
          Loading
        </p>
      ) : null}
      {expanded && dirState?.status === "error" ? (
        <p
          className="py-[3px] text-[11px] text-destructive"
          style={{ paddingLeft: 30 + (depth + 1) * 12 }}
        >
          {dirState.message}
        </p>
      ) : null}
      {expanded &&
      dirState?.status === "loaded" &&
      dirState.entries.length === 0 ? (
        <p
          className="py-[3px] text-[11px] text-muted-foreground"
          style={{ paddingLeft: 30 + (depth + 1) * 12 }}
        >
          Empty
        </p>
      ) : null}
    </>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <p className="px-3 py-3 text-[11px] text-muted-foreground">{text}</p>
  );
}
