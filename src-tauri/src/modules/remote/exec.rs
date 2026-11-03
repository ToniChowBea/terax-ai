//! Search and listing on the remote side.
//!
//! Walking a tree over individual SFTP requests is unusably slow (one
//! round-trip per directory), so these hand the walk to `find` and `grep`,
//! which are already there.
//!
//! Strictly POSIX: a minimal server (BusyBox, an Alpine container) has neither
//! GNU `grep --exclude-dir` nor `-I`, and silently returns nothing when handed
//! them. Pruning therefore happens in `find`, and `-exec ... {} +` is used
//! instead of `xargs`, which needs a non-portable `-r` to avoid running on an
//! empty list.

use super::conn::RemoteConn;
use super::path;
use crate::modules::fs::grep::{GlobHit, GlobResponse, GrepHit, GrepResponse};
use crate::modules::fs::search::{ListFilesResult, SearchHit, SearchResult};

/// Directory names pruned unconditionally, matching the local walker.
const PRUNED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

fn prune_expr() -> String {
    let names: Vec<String> = PRUNED
        .iter()
        .map(|n| format!("-name {}", path::quote(n)))
        .collect();
    format!("\\( {} \\) -prune -o", names.join(" -o "))
}

/// Path relative to the search root, for display.
fn relative(root: &str, full: &str) -> String {
    let root = root.trim_end_matches('/');
    full.strip_prefix(root)
        .map(|r| r.trim_start_matches('/').to_owned())
        .unwrap_or_else(|| full.to_owned())
}

fn hidden_filter(show_hidden: bool) -> &'static str {
    // `find` has no "skip dotfiles" flag; a negated path test is the portable
    // way, and `!` is POSIX where `-not` is a GNU spelling.
    if show_hidden {
        ""
    } else {
        " ! -path '*/.*'"
    }
}

/// `find` evaluates left to right, and `-print` is an action that always
/// succeeds and prints. A test placed after it is still evaluated, but its
/// result is discarded, so the hidden filter has to come first or dotfiles are
/// listed regardless of the setting.
fn build_list_command(root: &str, depth: &str, show_hidden: bool, limit: usize) -> String {
    format!(
        "find {}{} {} -type f{} -print 2>/dev/null | head -n {}",
        path::quote(root),
        depth,
        prune_expr(),
        hidden_filter(show_hidden),
        limit + 1,
    )
}

/// Every entry under the root, directories marked with a trailing `/` so one
/// walk answers both "what" and "is it a directory". Capped so a huge tree
/// (a home directory, a monorepo) costs a bounded walk rather than a hang.
fn build_search_command(root: &str, show_hidden: bool) -> String {
    format!(
        "find {} {} \\( -type d{} -exec printf '%s/\\n' {{}} + \\) -o \\( -type f{} -print \\) 2>/dev/null | head -n {}",
        path::quote(root),
        prune_expr(),
        hidden_filter(show_hidden),
        hidden_filter(show_hidden),
        SEARCH_WALK_CAP,
    )
}

/// Entries one remote search will look at. Beyond this the result is marked
/// truncated; the user narrows the root or the query.
pub const SEARCH_WALK_CAP: usize = 20_000;

/// A walk that does not finish in this long is reported as truncated rather
/// than holding the search box open (slow NFS, enormous trees).
const SEARCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub async fn list_files(
    conn: &RemoteConn,
    root: &str,
    limit: usize,
    max_depth: Option<usize>,
    show_hidden: bool,
) -> Result<ListFilesResult, String> {
    let depth = max_depth
        .map(|d| format!(" -maxdepth {d}"))
        .unwrap_or_default();
    // One extra result tells us the listing was cut short.
    let out = conn
        .exec(&build_list_command(root, &depth, show_hidden, limit))
        .await?;
    let text = out.stdout_text();
    let mut files: Vec<String> = text.lines().map(str::to_owned).collect();
    let truncated = files.len() > limit;
    files.truncate(limit);
    Ok(ListFilesResult { files, truncated })
}

pub async fn search(
    conn: &RemoteConn,
    root: &str,
    query: &str,
    limit: usize,
    show_hidden: bool,
) -> Result<SearchResult, String> {
    let empty = |truncated| SearchResult {
        hits: Vec::new(),
        truncated,
        cancelled: false,
    };
    if query.trim().is_empty() {
        return Ok(empty(false));
    }
    // Name matching happens here rather than in a remote regex so the query is
    // never interpreted as a pattern by a program on the far side.
    let walk = tokio::time::timeout(
        SEARCH_TIMEOUT,
        conn.exec(&build_search_command(root, show_hidden)),
    )
    .await;
    let Ok(out) = walk else {
        return Ok(empty(true));
    };
    let text = out?.stdout_text();
    Ok(rank_search(root, &text, query, limit))
}

/// Fuzzy-rank a remote walk exactly like the local index does (nucleo, path
/// matching, smart case), so Cmd+P behaves the same on both sides.
pub(crate) fn rank_search(root: &str, listing: &str, query: &str, limit: usize) -> SearchResult {
    use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
    use nucleo_matcher::{Config, Matcher, Utf32Str};

    let root_trimmed = root.trim_end_matches('/');
    let mut entries: Vec<(String, bool)> = Vec::new();
    let mut seen = 0usize;
    for line in listing.lines() {
        seen += 1;
        let (full, is_dir) = match line.strip_suffix('/') {
            Some(dir) if !dir.is_empty() => (dir, true),
            _ => (line, false),
        };
        if full == root_trimmed || full.is_empty() {
            continue;
        }
        entries.push((full.to_owned(), is_dir));
    }

    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(query.trim(), CaseMatching::Smart, Normalization::Smart);
    let mut buf = Vec::new();
    let mut scored: Vec<(u32, usize)> = Vec::new();
    for (i, (full, _)) in entries.iter().enumerate() {
        let rel = relative(root, full);
        if let Some(score) = pattern.score(Utf32Str::new(&rel, &mut buf), &mut matcher) {
            scored.push((score, i));
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| entries[a.1].0.len().cmp(&entries[b.1].0.len()))
    });
    let truncated = scored.len() > limit || seen >= SEARCH_WALK_CAP;
    let hits = scored
        .into_iter()
        .take(limit)
        .map(|(_, i)| {
            let (full, is_dir) = &entries[i];
            SearchHit {
                path: full.clone(),
                rel: relative(root, full),
                name: path::basename(full).to_owned(),
                is_dir: *is_dir,
            }
        })
        .collect();
    SearchResult {
        hits,
        truncated,
        cancelled: false,
    }
}

pub async fn grep(
    conn: &RemoteConn,
    root: &str,
    query: &str,
    limit: usize,
    case_sensitive: bool,
) -> Result<GrepResponse, String> {
    if query.is_empty() {
        return Ok(GrepResponse {
            hits: Vec::new(),
            truncated: false,
            files_scanned: 0,
            cancelled: false,
        });
    }
    let flags = if case_sensitive { "-n" } else { "-ni" };
    // `/dev/null` as an extra operand forces the filename prefix even when the
    // batch holds a single file, which is the portable equivalent of `-H`.
    // `-e` keeps a query starting with `-` from being read as a flag.
    let cmd = format!(
        "find {} {} -type f{} -exec grep {} -e {} /dev/null {{}} + 2>/dev/null | head -n {}",
        path::quote(root),
        prune_expr(),
        hidden_filter(true),
        flags,
        path::quote(query),
        limit + 1,
    );
    let out = conn.exec(&cmd).await?;
    let text = out.stdout_text();

    let mut hits: Vec<GrepHit> = Vec::new();
    for line in text.lines() {
        // Without GNU `-I` a binary file can still match; its line carries NUL
        // or control bytes, which the UI has no way to render.
        if line.chars().any(|c| c == '\0') {
            continue;
        }
        // grep -n prints `path:line:text`; a path may itself contain a colon,
        // so split from the left only as far as the two known fields.
        let Some((file, rest)) = split_grep_line(line, root) else {
            continue;
        };
        let Some((number, text)) = rest.split_once(':') else {
            continue;
        };
        let Ok(number) = number.parse::<u64>() else {
            continue;
        };
        hits.push(GrepHit {
            path: file.to_owned(),
            rel: relative(root, file),
            line: number,
            text: text.to_owned(),
        });
    }
    let truncated = hits.len() > limit;
    hits.truncate(limit);

    let files_scanned = hits
        .iter()
        .map(|h| h.path.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    Ok(GrepResponse {
        hits,
        truncated,
        files_scanned,
        cancelled: false,
    })
}

/// Split `path:line:text` when the path itself may contain colons. The path
/// always starts with the search root, so match the longest prefix that is
/// followed by a digit run and another colon.
fn split_grep_line<'a>(line: &'a str, root: &str) -> Option<(&'a str, &'a str)> {
    if !line.starts_with(root) {
        return line.split_once(':');
    }
    let mut from = root.len();
    while let Some(offset) = line[from..].find(':') {
        let at = from + offset;
        let rest = &line[at + 1..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() && rest[digits.len()..].starts_with(':') {
            return Some((&line[..at], rest));
        }
        from = at + 1;
    }
    line.split_once(':')
}

pub async fn glob(
    conn: &RemoteConn,
    root: &str,
    pattern: &str,
    limit: usize,
) -> Result<GlobResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".to_owned());
    }
    // `find -path` takes a glob directly, so the pattern never reaches a shell.
    let cmd = format!(
        "find {} {} -type f -path {} -print 2>/dev/null | head -n {}",
        path::quote(root),
        prune_expr(),
        path::quote(&format!("*{pattern}*")),
        limit + 1,
    );
    let out = conn.exec(&cmd).await?;
    let text = out.stdout_text();
    let mut hits: Vec<GlobHit> = text
        .lines()
        .map(|l| GlobHit {
            path: l.to_owned(),
            rel: relative(root, l),
        })
        .collect();
    let truncated = hits.len() > limit;
    hits.truncate(limit);
    Ok(GlobResponse { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_strips_the_root() {
        assert_eq!(relative("/srv/app", "/srv/app/src/main.rs"), "src/main.rs");
        assert_eq!(relative("/srv/app/", "/srv/app/a.txt"), "a.txt");
        assert_eq!(relative("/srv/app", "/srv/app"), "");
    }

    #[test]
    fn relative_leaves_an_unrelated_path_alone() {
        assert_eq!(relative("/srv/app", "/etc/passwd"), "/etc/passwd");
    }

    #[test]
    fn grep_line_splits_a_plain_path() {
        let (file, rest) = split_grep_line("/srv/app/a.rs:12:hello", "/srv/app").unwrap();
        assert_eq!(file, "/srv/app/a.rs");
        assert_eq!(rest, "12:hello");
    }

    #[test]
    fn grep_line_splits_a_path_containing_a_colon() {
        // A colon is a legal filename character on POSIX.
        let (file, rest) = split_grep_line("/srv/app/we:ird.rs:3:x", "/srv/app").unwrap();
        assert_eq!(file, "/srv/app/we:ird.rs");
        assert_eq!(rest, "3:x");
    }

    #[test]
    fn grep_line_keeps_colons_in_the_matched_text() {
        let (file, rest) = split_grep_line("/srv/app/a.rs:7:let x = a:b:c;", "/srv/app").unwrap();
        assert_eq!(file, "/srv/app/a.rs");
        assert_eq!(rest, "7:let x = a:b:c;");
    }

    #[test]
    fn search_ranks_fuzzily_and_marks_directories() {
        let listing = "/srv/app/\n/srv/app/src/\n/srv/app/src/main.rs\n/srv/app/docs/main.md\n/srv/app/src/deeply/nested/config.rs\n/srv/app/config.rs\n";
        let res = rank_search("/srv/app", listing, "config", 10);
        assert_eq!(res.hits[0].rel, "config.rs", "shorter path ranks first");
        assert!(res.hits.iter().all(|h| h.rel != "src/main.rs"));

        let res = rank_search("/srv/app", listing, "smr", 10);
        assert_eq!(res.hits[0].rel, "src/main.rs", "subsequence match");

        let res = rank_search("/srv/app", listing, "src", 10);
        let src = res.hits.iter().find(|h| h.rel == "src").expect("dir hit");
        assert!(src.is_dir);
        assert_eq!(src.path, "/srv/app/src");
        assert!(!res.hits.iter().any(|h| h.rel.is_empty()), "root excluded");
    }

    #[test]
    fn search_reports_truncation_at_the_limit() {
        let listing: String = (0..30).map(|i| format!("/r/file{i}.txt\n")).collect();
        let res = rank_search("/r", &listing, "file", 5);
        assert_eq!(res.hits.len(), 5);
        assert!(res.truncated);
    }

    #[test]
    fn search_walk_is_capped() {
        let cmd = build_search_command("/srv", true);
        assert!(
            cmd.ends_with(&format!("head -n {SEARCH_WALK_CAP}")),
            "{cmd}"
        );
    }

    #[test]
    fn prune_expression_quotes_every_name() {
        let expr = prune_expr();
        assert!(expr.contains("-name '.git'"));
        assert!(expr.contains("-name 'node_modules'"));
        assert!(expr.starts_with("\\("));
        assert!(expr.ends_with("-prune -o"));
    }

    #[test]
    fn the_hidden_filter_precedes_the_print_action() {
        // -print always succeeds and prints, so a test placed after it is
        // evaluated and discarded: dotfiles would be listed anyway.
        for cmd in [
            build_list_command("/srv", "", false, 10),
            build_search_command("/srv", false),
        ] {
            let filter = cmd.find("! -path").expect("filter present");
            let print = cmd.find("-print").expect("print present");
            assert!(filter < print, "filter must come first in: {cmd}");
        }
    }

    #[test]
    fn hidden_filter_is_only_applied_when_hiding() {
        assert_eq!(hidden_filter(true), "");
        assert!(
            hidden_filter(false).contains("! -path"),
            "POSIX negation, not the GNU -not spelling"
        );
    }
}
