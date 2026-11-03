//! One authenticated SSH connection per destination, shared by everything
//! that talks to that host (fork-only, SSH port).
//!
//! Before this, every terminal tab, the remote file browser and a remote
//! workspace each ran their own handshake, so a password host asked for the
//! password once per consumer. SSH multiplexes channels over one transport,
//! so all of them now lease the same connection: shell channels, the SFTP
//! subsystem, exec channels and `direct-tcpip` forwards.
//!
//! Lifetime is reference counted. Every consumer holds an `Arc<PooledConn>`;
//! the pool only keeps a `Weak`, so the connection is disconnected when the
//! last consumer lets go and a later connect starts fresh. A per-key async
//! lock serialises connects, so two consumers opening at the same moment
//! still cause exactly one handshake (and one prompt).
//!
//! Credentials are never stored: reuse works because the transport stays
//! authenticated, not because a password is remembered.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use russh::client;

use super::session::{connect_authenticated, Handler, PromptBus};
use super::target::{self, ResolvedTarget, SshTarget};

pub struct PooledConn {
    handle: Option<client::Handle<Handler>>,
    pub resolved: ResolvedTarget,
    key: String,
}

impl PooledConn {
    pub fn handle(&self) -> &client::Handle<Handler> {
        self.handle.as_ref().expect("handle present until drop")
    }

    pub fn is_closed(&self) -> bool {
        self.handle().is_closed()
    }

    pub fn key(&self) -> &str {
        &self.key
    }
}

impl Drop for PooledConn {
    /// The last lease is gone: say goodbye properly instead of letting the
    /// server notice a dropped socket.
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let key = self.key.clone();
            let disconnect = async move {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
                log::info!("ssh pool: closed {key}");
            };
            match tokio::runtime::Handle::try_current() {
                Ok(rt) => {
                    rt.spawn(disconnect);
                }
                Err(_) => {
                    tauri::async_runtime::spawn(disconnect);
                }
            }
        }
    }
}

#[derive(Default)]
struct Pool {
    live: Mutex<HashMap<String, Weak<PooledConn>>>,
    /// One lock per destination, held across a handshake.
    connecting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Handshakes completed per destination, for tests and diagnostics.
    connects: Mutex<HashMap<String, u64>>,
}

static POOL: OnceLock<Pool> = OnceLock::new();
static TOTAL_CONNECTS: AtomicU64 = AtomicU64::new(0);

fn pool() -> &'static Pool {
    POOL.get_or_init(Pool::default)
}

/// Identity of a destination: who, where, and by which route. Auth methods
/// are deliberately not part of it: an already authenticated transport for
/// the same user is exactly what the second consumer would end up with.
pub fn key_for(target: &SshTarget) -> Result<String, String> {
    let r = target::resolve_target(target)?;
    let mut key = format!("{}@{}:{}", r.user, r.host, r.port);
    for hop in &target.jumps {
        key.push_str(" via ");
        key.push_str(&key_for(hop)?);
    }
    Ok(key)
}

#[doc(hidden)]
pub fn scoped_key(scope: &str, target: &SshTarget) -> Result<String, String> {
    let key = key_for(target)?;
    Ok(if scope.is_empty() {
        key
    } else {
        format!("{scope}#{key}")
    })
}

fn live(key: &str) -> Option<Arc<PooledConn>> {
    let mut map = pool().live.lock().unwrap();
    match map.get(key).and_then(Weak::upgrade) {
        Some(conn) if !conn.is_closed() => Some(conn),
        Some(_) | None => {
            map.remove(key);
            None
        }
    }
}

/// A connection to `target`, reusing a live one when there is one. Prompts
/// (host key, password) for a new handshake go to `bus`.
pub async fn acquire(target: &SshTarget, bus: &Arc<PromptBus>) -> Result<Arc<PooledConn>, String> {
    acquire_scoped("", target, bus).await
}

/// `acquire` with an extra namespace in the key. Only the live tests use a
/// non-empty scope, to get a connection no concurrently running test shares.
#[doc(hidden)]
pub async fn acquire_scoped(
    scope: &str,
    target: &SshTarget,
    bus: &Arc<PromptBus>,
) -> Result<Arc<PooledConn>, String> {
    let key = scoped_key(scope, target)?;
    if let Some(conn) = live(&key) {
        log::debug!("ssh pool: reusing {key}");
        return Ok(conn);
    }

    let gate = pool()
        .connecting
        .lock()
        .unwrap()
        .entry(key.clone())
        .or_default()
        .clone();
    let _guard = gate.lock().await;

    // Someone else may have finished the handshake while we waited.
    if let Some(conn) = live(&key) {
        return Ok(conn);
    }

    let (handle, resolved) = connect_authenticated(target, bus).await?;
    let conn = Arc::new(PooledConn {
        handle: Some(handle),
        resolved,
        key: key.clone(),
    });
    pool()
        .live
        .lock()
        .unwrap()
        .insert(key.clone(), Arc::downgrade(&conn));
    *pool()
        .connects
        .lock()
        .unwrap()
        .entry(key.clone())
        .or_default() += 1;
    TOTAL_CONNECTS.fetch_add(1, Ordering::Relaxed);
    log::info!("ssh pool: connected {key}");
    Ok(conn)
}

/// Open a session channel on a shared connection, riding out a full one.
///
/// Every consumer of a host now shares one transport, and OpenSSH caps the
/// channels open on a connection (`MaxSessions`, 10 by default). Exec
/// channels are short-lived, so a refusal is usually momentary: retry with
/// backoff for a couple of seconds before giving up with a message that
/// names the real cause.
pub async fn open_session_channel(
    handle: &client::Handle<Handler>,
) -> Result<russh::Channel<client::Msg>, String> {
    let mut delay = std::time::Duration::from_millis(25);
    let mut last = String::new();
    for _ in 0..8 {
        match handle.channel_open_session().await {
            Ok(channel) => return Ok(channel),
            Err(russh::Error::ChannelOpenFailure(reason)) => {
                last = format!("{reason:?}");
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(std::time::Duration::from_millis(500));
            }
            Err(e) => return Err(format!("could not open a channel: {e}")),
        }
    }
    Err(format!(
        "the server refused another channel on this connection ({last}); it \
         is probably at its MaxSessions limit (10 by default in OpenSSH). \
         Close a tab to this host or raise MaxSessions in sshd_config"
    ))
}

/// Handshakes completed for this destination since the process started.
pub fn connects_for(key: &str) -> u64 {
    pool()
        .connects
        .lock()
        .unwrap()
        .get(key)
        .copied()
        .unwrap_or(0)
}

pub fn total_connects() -> u64 {
    TOTAL_CONNECTS.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(host: &str, user: &str, port: Option<u16>) -> SshTarget {
        SshTarget {
            host: host.into(),
            port,
            user: user.into(),
            auth: Vec::new(),
            term: None,
            cwd: None,
            command: None,
            keepalive_secs: None,
            connect_timeout_secs: None,
            compression: None,
            env: Vec::new(),
            jumps: Vec::new(),
        }
    }

    #[test]
    fn key_ignores_per_tab_options_but_not_the_destination() {
        let a = t("example.com", "me", None);
        let mut b = t("example.com", "me", Some(22));
        b.cwd = Some("/srv".into());
        b.command = Some("htop".into());
        assert_eq!(key_for(&a).unwrap(), key_for(&b).unwrap());
        assert_ne!(
            key_for(&a).unwrap(),
            key_for(&t("example.com", "other", None)).unwrap()
        );
        assert_ne!(
            key_for(&a).unwrap(),
            key_for(&t("example.com", "me", Some(2222))).unwrap()
        );
    }

    #[test]
    fn key_includes_the_route() {
        let direct = t("inner", "me", None);
        let mut jumped = t("inner", "me", None);
        jumped.jumps = vec![t("bastion", "me", None)];
        assert_ne!(key_for(&direct).unwrap(), key_for(&jumped).unwrap());
    }
}
