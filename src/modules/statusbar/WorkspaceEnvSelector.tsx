import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IS_WINDOWS } from "@/lib/platform";
import { useRemoteHostsStore, useRemotesStore } from "@/modules/remotes";
import {
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { Refresh01Icon, ServerStack03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  /** Resolves false when the switch was refused, e.g. unsaved editor tabs. */
  onSelect: (env: WorkspaceEnv) => Promise<boolean>;
};

/**
 * Shown when there is something to switch between: WSL on Windows, or a remote
 * workspace on any platform. Elsewhere the environment is always local, and a
 * one-item picker would be noise.
 */
export function WorkspaceEnvSelector({ onSelect }: Props) {
  const env = useWorkspaceEnvStore((s) => s.env);
  if (!IS_WINDOWS && env.kind !== "ssh") return null;
  return <WorkspaceEnvPicker onSelect={onSelect} />;
}

function WorkspaceEnvPicker({ onSelect }: Props) {
  const env = useWorkspaceEnvStore((s) => s.env);
  const localEnv = useWorkspaceEnvStore((s) => s.localEnv);
  // Fork-only (SSH port): the host whose files are in view, if any. Which
  // machine is in view follows the active tab; this picker only reports it
  // and offers to disconnect it.
  const remote = useRemoteHostsStore((s) =>
    env.kind === "ssh" ? s.hosts[env.profileId] : undefined,
  );
  const remoteName = useRemotesStore((s) =>
    env.kind === "ssh"
      ? s.profiles.find((p) => p.id === env.profileId)?.name
      : undefined,
  );
  const distros = useWorkspaceEnvStore((s) => s.distros);
  const loading = useWorkspaceEnvStore((s) => s.loading);
  const error = useWorkspaceEnvStore((s) => s.error);
  const refreshDistros = useWorkspaceEnvStore((s) => s.refreshDistros);

  const handleOpenChange = (open: boolean) => {
    if (open && IS_WINDOWS && distros.length === 0 && !loading) {
      void refreshDistros();
    }
  };

  const localLabel = IS_WINDOWS ? "Windows Local" : "Local";
  const shown = env.kind === "ssh" ? localEnv : env;
  const label =
    env.kind === "ssh"
      ? remote
        ? `${remote.user}@${remote.host}`
        : (remoteName ?? "Remote")
      : shown.kind === "wsl"
        ? `WSL: ${shown.distro}`
        : localLabel;

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title="Workspace environment"
        >
          <HugeiconsIcon
            icon={ServerStack03Icon}
            size={13}
            strokeWidth={1.75}
          />
          <span className="max-w-28 truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuItem onSelect={() => void onSelect(LOCAL_WORKSPACE)}>
          {localLabel}
        </DropdownMenuItem>
        {env.kind === "ssh" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              Files follow the active tab
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                void useRemoteHostsStore.getState().close(env.profileId)
              }
            >
              Disconnect file access to {remoteName ?? "this host"}
            </DropdownMenuItem>
          </>
        ) : null}
        {!IS_WINDOWS ? null : (
        <>
        <DropdownMenuSeparator />
        {distros.length === 0 ? (
          <DropdownMenuItem disabled>
            {loading
              ? "Loading WSL distros..."
              : error
                ? "WSL unavailable"
                : "No WSL distros found"}
          </DropdownMenuItem>
        ) : (
          distros.map((distro) => (
            <DropdownMenuItem
              key={distro.name}
              onSelect={() => void onSelect({ kind: "wsl", distro: distro.name })}
            >
              WSL: {distro.name}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void refreshDistros()}>
          <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
          Refresh
        </DropdownMenuItem>
        </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
