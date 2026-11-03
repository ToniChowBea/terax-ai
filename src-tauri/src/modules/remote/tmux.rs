//! Persistent sessions: list and manage tmux sessions on a remote host
//! (fork-only, SSH port).
//!
//! Everything runs over the host's shared, already authenticated connection
//! (an exec channel per command), so it never prompts for a password.
//!
//! Session names come from the server and are untrusted. They never reach a
//! shell unquoted: commands target a session by its stable `$<n>` id (which
//! the server generates and which this module validates), and the only name
//! ever sent is a new one the user typed, which is validated and then
//! single-quoted. `=` prefixes force tmux's exact match so a name can never
//! be taken as a pattern.

use serde::Serialize;

use super::conn::RemoteConn;
use super::path::quote;

/// One tmux session as `tmux list-sessions` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    /// tmux's own id, `$0`, `$1`... Stable across renames.
    pub id: String,
    pub name: String,
    pub windows: u32,
    /// Number of clients attached (0 means detached).
    pub attached: u32,
    /// Seconds since the epoch.
    pub created: u64,
    pub activity: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum TmuxListing {
    /// tmux is present; the list may be empty (no server running).
    Ok { sessions: Vec<TmuxSession> },
    /// tmux is not installed on the host.
    NotInstalled,
}

/// Name last: tmux escapes control characters in format output but not
/// spaces or tabs it did not generate, so the free-form field goes where a
/// stray separator inside it cannot shift the others.
const LIST_FORMAT: &str =
    "#{session_id} #{session_windows} #{session_attached} #{session_created} #{session_activity} #{session_name}";

/// `command -v` first so "not installed" is told apart from "no server".
/// Exit 127 from the probe means not installed.
fn list_command() -> String {
    format!(
        "command -v tmux >/dev/null 2>&1 || exit 127; tmux list-sessions -F {} 2>&1; true",
        quote(LIST_FORMAT)
    )
}

/// Parse `list-sessions` output. Lines that do not match the format
/// (tmux's "no server running" message, warnings) are skipped, so an
/// absent server is an empty list rather than an error.
pub fn parse_sessions(output: &str) -> Vec<TmuxSession> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(6, ' ');
            let id = parts.next()?;
            if !is_session_id(id) {
                return None;
            }
            let windows = parts.next()?.parse().ok()?;
            let attached = parts.next()?.parse().ok()?;
            let created = parts.next()?.parse().ok()?;
            let activity = parts.next()?.parse().ok()?;
            // Verbatim: tmux already sanitized the name when the session was
            // made (it escapes control characters), and every action targets
            // the id, so the name is only ever displayed.
            let name = parts.next()?.to_owned();
            Some(TmuxSession {
                id: id.to_owned(),
                name,
                windows,
                attached,
                created,
                activity,
            })
        })
        .collect()
}

/// `$` followed by digits, which is all tmux ever generates. Anything else is
/// refused before it can reach a command line.
pub fn is_session_id(id: &str) -> bool {
    let Some(digits) = id.strip_prefix('$') else {
        return false;
    };
    !digits.is_empty() && digits.len() <= 10 && digits.bytes().all(|b| b.is_ascii_digit())
}

/// A name the user may give a new or renamed session. Stricter than tmux on
/// purpose: tmux rewrites `.` and `:` (target syntax) and a leading `-` or
/// `=` reads as an option or exact-match marker, so those are refused rather
/// than silently changed.
pub fn validate_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a session name cannot be empty".into());
    }
    if name.chars().count() > 64 {
        return Err("a session name can be at most 64 characters".into());
    }
    if name.starts_with('-') || name.starts_with('=') {
        return Err("a session name cannot start with '-' or '='".into());
    }
    if let Some(bad) = name
        .chars()
        .find(|c| matches!(c, '.' | ':' | '\'' | '"' | '\\' | '$' | '`') || c.is_control())
    {
        return Err(format!("a session name cannot contain {bad:?}"));
    }
    Ok(name)
}

fn target(id: &str) -> Result<String, String> {
    if !is_session_id(id) {
        return Err(format!("not a tmux session id: {id:?}"));
    }
    // `=` forces an exact match; quoting keeps `$` literal for the shell.
    Ok(quote(&format!("={id}")))
}

/// The command a terminal channel execs to attach. Built here, never from a
/// string the frontend sent.
pub fn attach_command(id: &str) -> Result<String, String> {
    Ok(format!("exec tmux attach-session -t {}", target(id)?))
}

async fn run(conn: &RemoteConn, command: &str) -> Result<(), String> {
    let out = conn.exec(command).await?;
    if out.ok() {
        Ok(())
    } else {
        let err = out.stderr_text();
        let msg = err.trim();
        Err(if msg.is_empty() {
            format!("tmux exited with {}", out.code)
        } else {
            msg.to_owned()
        })
    }
}

pub async fn list(conn: &RemoteConn) -> Result<TmuxListing, String> {
    let out = conn.exec(&list_command()).await?;
    if out.code == 127 {
        return Ok(TmuxListing::NotInstalled);
    }
    Ok(TmuxListing::Ok {
        sessions: parse_sessions(&out.stdout_text()),
    })
}

/// Create a detached session and return its id, for an immediate attach.
pub async fn create(conn: &RemoteConn, name: &str) -> Result<String, String> {
    let name = validate_name(name)?;
    let out = conn
        .exec(&format!(
            "tmux new-session -d -P -F '#{{session_id}}' -s {}",
            quote(name)
        ))
        .await?;
    if !out.ok() {
        let err = out.stderr_text();
        return Err(err.trim().to_owned());
    }
    let id = out.stdout_text().trim().to_owned();
    if !is_session_id(&id) {
        return Err(format!("tmux returned an unexpected id {id:?}"));
    }
    Ok(id)
}

pub async fn rename(conn: &RemoteConn, id: &str, name: &str) -> Result<(), String> {
    let name = validate_name(name)?;
    run(
        conn,
        &format!("tmux rename-session -t {} {}", target(id)?, quote(name)),
    )
    .await
}

pub async fn kill(conn: &RemoteConn, id: &str) -> Result<(), String> {
    run(conn, &format!("tmux kill-session -t {}", target(id)?)).await
}

/// Detach every client attached to the session. The attached Terax tab's
/// tmux client exits, which ends that tab's channel.
pub async fn detach(conn: &RemoteConn, id: &str) -> Result<(), String> {
    run(conn, &format!("tmux detach-client -s {}", target(id)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_sessions_output() {
        let out = "$0 2 1 1793705095 1793705200 work\n$3 1 0 1793705000 1793705001 build\n";
        let s = parse_sessions(out);
        assert_eq!(s.len(), 2);
        assert_eq!(
            s[0],
            TmuxSession {
                id: "$0".into(),
                name: "work".into(),
                windows: 2,
                attached: 1,
                created: 1793705095,
                activity: 1793705200,
            }
        );
        assert_eq!(s[1].attached, 0);
    }

    #[test]
    fn odd_names_survive_parsing() {
        let out = concat!(
            "$1 1 0 1 2 we ird name\n",
            "$2 1 0 1 2 q'uote $x `y` ;rm -rf ~\n",
            "$4 1 0 1 2 tab\\011here\n",
            "$7 1 0 1 2 back\\\\slash \\$HOME\n",
            "$5 1 0 1 2 ünïcødé ☃\n",
            "$6 1 0 1 2  leading space\n",
        );
        let s = parse_sessions(out);
        let names: Vec<&str> = s.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "we ird name",
                "q'uote $x `y` ;rm -rf ~",
                "tab\\011here",
                "back\\\\slash \\$HOME",
                "ünïcødé ☃",
                " leading space",
            ]
        );
    }

    #[test]
    fn no_server_and_noise_are_an_empty_list() {
        assert!(parse_sessions("no server running on /tmp/tmux-1000/default\n").is_empty());
        assert!(parse_sessions("").is_empty());
        assert!(parse_sessions(
            "error connecting to /tmp/tmux-1/default (No such file or directory)"
        )
        .is_empty());
        // A line with a forged id or non-numeric fields is dropped.
        assert!(parse_sessions("x0 1 0 1 2 name\n$1 a 0 1 2 name\n$ 1 0 1 2 n").is_empty());
    }

    #[test]
    fn session_ids_are_strict() {
        assert!(is_session_id("$0"));
        assert!(is_session_id("$123"));
        for bad in [
            "",
            "$",
            "0",
            "$-1",
            "$1;",
            "$1 2",
            "$1'",
            "=$1",
            "$12345678901",
        ] {
            assert!(!is_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn commands_never_embed_a_raw_name_or_id() {
        assert_eq!(
            attach_command("$3").unwrap(),
            "exec tmux attach-session -t '=$3'"
        );
        assert!(attach_command("$3; rm -rf ~").is_err());
        assert!(attach_command("work").is_err());
        assert!(target("$1'").is_err());
    }

    #[test]
    fn names_are_validated() {
        assert_eq!(validate_name("  dev server ").unwrap(), "dev server");
        for bad in [
            "", "   ", "-x", "=x", "a.b", "a:b", "a'b", "a\"b", "a$b", "a`b", "a\\b", "a\tb",
            "a\nb",
        ] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_name(&"x".repeat(65)).is_err());
        assert!(validate_name("ünïcødé ☃").is_ok());
    }

    #[test]
    fn list_command_separates_not_installed_from_no_server() {
        let cmd = list_command();
        assert!(cmd.starts_with("command -v tmux"));
        assert!(cmd.contains("exit 127"));
        // The format is single-quoted, so `#{...}` is not touched by the shell.
        assert!(cmd.contains("-F '#{session_id} "));
    }
}
