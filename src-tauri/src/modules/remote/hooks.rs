//! Fork-only hook points that let upstream filesystem and shell commands serve
//! a remote (SSH) workspace without changing their signatures.
//!
//! Each upstream `#[tauri::command]` gets a single early return:
//!
//! ```ignore
//! if let Some(r) = remote::hooks::read_dir(&workspace, &path, show_hidden).await {
//!     return r;
//! }
//! ```
//!
//! A hook returns `None` for a local or WSL workspace, so upstream behaviour is
//! untouched there. The remote state is reached through `remote::global()`, so
//! no command needs an extra `tauri::State` argument. Keeping all the remote
//! branching in this file is what keeps rebases onto upstream cheap: upstream
//! edits to the commands themselves only ever conflict on one line each.

use std::sync::Arc;
use std::time::Duration;

use super::conn::RemoteConn;
use super::{exec, fs, global, path, resolve};
use crate::modules::fs::copy::{CopyFailure, CopyResult};
use crate::modules::fs::file::{FileStat, ReadResult};
use crate::modules::fs::grep::{GlobResponse, GrepResponse};
use crate::modules::fs::mutate::{FsDeleteBatchResult, FsMoveResult};
use crate::modules::fs::search::{ListFilesResult, SearchResult};
use crate::modules::fs::tree::DirEntry;
use crate::modules::shell::CommandOutput;
use crate::modules::workspace::WorkspaceEnv;

type Hook<T> = Option<Result<T, String>>;

fn conn_id(workspace: &Option<WorkspaceEnv>) -> Option<u32> {
    workspace.as_ref().and_then(WorkspaceEnv::remote_conn)
}

fn require(conn: u32) -> Result<Arc<RemoteConn>, String> {
    global()
        .ok_or_else(|| "remote state unavailable".to_owned())?
        .require(conn)
}

/// Shorthand: bail out with `None` for a local workspace, otherwise run `body`
/// against the live connection.
macro_rules! remote {
    ($ws:expr, |$c:ident| $body:expr) => {{
        let conn = conn_id($ws)?;
        Some(
            async {
                let $c = require(conn)?;
                $body
            }
            .await,
        )
    }};
}

pub async fn read_dir(ws: &Option<WorkspaceEnv>, dir: &str, show_hidden: bool) -> Hook<Vec<DirEntry>> {
    remote!(ws, |c| fs::read_dir(&c, &resolve(&c, dir), show_hidden).await)
}

pub async fn list_subdirs(ws: &Option<WorkspaceEnv>, dir: &str, show_hidden: bool) -> Hook<Vec<String>> {
    remote!(ws, |c| fs::list_subdirs(&c, &resolve(&c, dir), show_hidden).await)
}

pub async fn read_file(ws: &Option<WorkspaceEnv>, file: &str, force: bool) -> Hook<ReadResult> {
    remote!(ws, |c| fs::read_file(&c, &resolve(&c, file), force).await)
}

pub async fn write_file(ws: &Option<WorkspaceEnv>, file: &str, content: &str) -> Hook<u64> {
    remote!(ws, |c| {
        let target = resolve(&c, file);
        c.authorize_mutation(&target)?;
        fs::write_file(&c, &target, content).await
    })
}

pub async fn canonicalize(ws: &Option<WorkspaceEnv>, p: &str) -> Hook<String> {
    remote!(ws, |c| fs::canonicalize(&c, &resolve(&c, p)).await)
}

pub async fn stat(ws: &Option<WorkspaceEnv>, p: &str) -> Hook<FileStat> {
    remote!(ws, |c| fs::stat(&c, &resolve(&c, p)).await)
}

pub async fn create_file(ws: &Option<WorkspaceEnv>, p: &str) -> Hook<()> {
    remote!(ws, |c| {
        let target = resolve(&c, p);
        c.authorize_mutation(&target)?;
        fs::create_file(&c, &target).await
    })
}

pub async fn create_dir(ws: &Option<WorkspaceEnv>, p: &str) -> Hook<()> {
    remote!(ws, |c| {
        let target = resolve(&c, p);
        c.authorize_mutation(&target)?;
        fs::create_dir(&c, &target).await
    })
}

pub async fn rename(ws: &Option<WorkspaceEnv>, from: &str, to: &str) -> Hook<()> {
    remote!(ws, |c| {
        let (f, t) = (resolve(&c, from), resolve(&c, to));
        c.authorize_mutation(&f)?;
        c.authorize_mutation(&t)?;
        fs::rename(&c, &f, &t).await
    })
}

pub async fn delete(ws: &Option<WorkspaceEnv>, p: &str) -> Hook<()> {
    remote!(ws, |c| {
        let target = resolve(&c, p);
        c.authorize_mutation(&target)?;
        fs::delete(&c, std::slice::from_ref(&target)).await
    })
}

/// Same contract as the local move: never clobber unless the exact conflict
/// the user was shown is passed back. The conflict token is the target path.
pub async fn move_path(
    ws: &Option<WorkspaceEnv>,
    from: &str,
    to: &str,
    expected_conflict: Option<&str>,
) -> Hook<FsMoveResult> {
    remote!(ws, |c| {
        let (f, t) = (resolve(&c, from), resolve(&c, to));
        c.authorize_mutation(&f)?;
        c.authorize_mutation(&t)?;
        if f == t {
            return Ok(FsMoveResult::Moved);
        }
        let exists = {
            let sftp = c.sftp().await;
            sftp.try_exists(t.clone()).await.unwrap_or(false)
        };
        if exists {
            if expected_conflict != Some(t.as_str()) {
                return Ok(FsMoveResult::Conflict {
                    // SFTP cannot merge directories safely; only a file may be
                    // replaced.
                    replaceable: !fs::is_dir(&c, &t).await,
                    token: t.clone(),
                });
            }
            fs::delete(&c, std::slice::from_ref(&t)).await?;
        }
        fs::rename(&c, &f, &t).await?;
        Ok(FsMoveResult::Moved)
    })
}

/// One `rm` for the whole batch: a round trip per entry would make deleting a
/// selection unusably slow over a link with any latency. Never fails; outcomes
/// are reported in the counts like the local command.
pub async fn delete_batch(ws: &Option<WorkspaceEnv>, paths: &[String]) -> Option<FsDeleteBatchResult> {
    let conn = conn_id(ws)?;
    let all_failed = || FsDeleteBatchResult::new(Vec::new(), paths.len());
    let Ok(c) = require(conn) else {
        return Some(all_failed());
    };
    let mut resolved = Vec::with_capacity(paths.len());
    let mut rejected = 0;
    for p in paths {
        let target = resolve(&c, p);
        if c.authorize_mutation(&target).is_ok() {
            resolved.push((p.clone(), target));
        } else {
            rejected += 1;
            log::warn!("fs_delete_batch refused {target} outside the remote workspace");
        }
    }
    if resolved.is_empty() {
        return Some(all_failed());
    }
    let targets: Vec<String> = resolved.iter().map(|(_, t)| t.clone()).collect();
    Some(match fs::delete(&c, &targets).await {
        Ok(()) => FsDeleteBatchResult::new(resolved.into_iter().map(|(o, _)| o).collect(), rejected),
        Err(e) => {
            log::warn!("fs_delete_batch remote failed: {e}");
            all_failed()
        }
    })
}

/// Drag-and-drop onto a remote workspace: sources are local paths, so this is
/// an upload rather than a server-side copy. Refuses to overwrite.
pub async fn copy(ws: &Option<WorkspaceEnv>, sources: &[String], dest_dir: &str) -> Hook<CopyResult> {
    remote!(ws, |c| {
        let dest = resolve(&c, dest_dir);
        c.authorize_mutation(&dest)?;
        let mut result = CopyResult {
            created: Vec::new(),
            failed: Vec::new(),
        };
        for source in sources {
            match fs::upload(&c, std::slice::from_ref(source), &dest).await {
                Ok(()) => {
                    let name = std::path::Path::new(source)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    result.created.push(path::join(&dest, &name));
                }
                Err(message) => result.failed.push(CopyFailure {
                    source: source.clone(),
                    message,
                }),
            }
        }
        Ok(result)
    })
}

pub async fn grep(
    ws: &Option<WorkspaceEnv>,
    root: &str,
    pattern: &str,
    max_results: usize,
    case_sensitive: bool,
) -> Hook<GrepResponse> {
    remote!(ws, |c| exec::grep(&c, &resolve(&c, root), pattern, max_results, case_sensitive).await)
}

pub async fn glob(ws: &Option<WorkspaceEnv>, root: &str, pattern: &str, max_results: usize) -> Hook<GlobResponse> {
    remote!(ws, |c| exec::glob(&c, &resolve(&c, root), pattern, max_results).await)
}

pub async fn search(
    ws: &Option<WorkspaceEnv>,
    root: &str,
    query: &str,
    limit: usize,
    show_hidden: bool,
) -> Hook<SearchResult> {
    remote!(ws, |c| exec::search(&c, &resolve(&c, root), query, limit, show_hidden).await)
}

pub async fn list_files(
    ws: &Option<WorkspaceEnv>,
    root: &str,
    limit: usize,
    max_depth: usize,
    show_hidden: bool,
) -> Hook<ListFilesResult> {
    remote!(ws, |c| exec::list_files(&c, &resolve(&c, root), limit, Some(max_depth), show_hidden).await)
}

/// SFTP has no change notification; watching a remote workspace is simply
/// unavailable rather than an error. The explorer refreshes on its own actions.
pub fn skip_watch(ws: &Option<WorkspaceEnv>) -> bool {
    conn_id(ws).is_some()
}

/// The agent's persistent session shell and background processes hold local
/// state (cwd, pid, log buffer) and must not silently fall through to the
/// local machine for a remote workspace.
pub fn local_only(ws: &Option<WorkspaceEnv>) -> Result<(), String> {
    if conn_id(ws).is_some() {
        return Err("background processes and agent sessions are local only; on a remote workspace run the command in the foreground instead".to_owned());
    }
    Ok(())
}

/// Run the agent's one-shot command on the remote host, confined to the roots
/// the connection has been given, as the local path is confined to the
/// authorized workspace.
pub async fn run_command(
    ws: &Option<WorkspaceEnv>,
    command: &str,
    cwd: Option<&str>,
    dur: Duration,
) -> Hook<CommandOutput> {
    remote!(ws, |c| {
        let full = match cwd.map(str::trim).filter(|s| !s.is_empty()) {
            Some(dir) => {
                let resolved = resolve(&c, dir);
                c.authorize_mutation(&resolved)?;
                format!("cd {} && {command}", path::quote(&resolved))
            }
            None => command.to_owned(),
        };
        match tokio::time::timeout(dur, c.exec(&full)).await {
            Err(_) => Ok(CommandOutput {
                stdout: String::new(),
                stderr: "the remote command timed out".to_owned(),
                exit_code: None,
                timed_out: true,
                truncated: false,
            }),
            Ok(out) => {
                let out = out?;
                Ok(CommandOutput {
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                    exit_code: Some(out.code),
                    timed_out: false,
                    truncated: out.truncated,
                })
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_workspaces_are_not_intercepted() {
        assert!(!skip_watch(&None));
        assert!(!skip_watch(&Some(WorkspaceEnv::Local)));
        assert!(local_only(&None).is_ok());
    }

    #[test]
    fn remote_workspace_refuses_local_only_features() {
        let ws = Some(WorkspaceEnv::Ssh { conn: 7 });
        assert!(skip_watch(&ws));
        let err = local_only(&ws).unwrap_err();
        assert!(err.contains("remote workspace"), "{err}");
    }

    #[tokio::test]
    async fn hooks_pass_through_for_local() {
        assert!(read_dir(&None, "/", false).await.is_none());
        assert!(stat(&Some(WorkspaceEnv::Local), "/").await.is_none());
    }
}
