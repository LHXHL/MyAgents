//! Workspace path resolution and traversal protection.
//!
//! All workspace file commands take an absolute `workspace_path` (the directory
//! the user is currently working inside) and a `relative` path or `target_dir`
//! the operation should affect. This module is the single chokepoint that turns
//! that pair into a validated absolute path that:
//!
//! 1. Resolves `..` and `.` components (no traversal escape).
//! 2. Stays inside `workspace_path` (no escape via symlink-aware canonicalization
//!    where the file already exists; for new paths we walk component-by-component).
//! 3. Passes the same system / credential directory blacklist used everywhere
//!    else in the app — see `commands::validate_file_path`.
//!
//! Centralizing these rules means a future "ah, also block X" only happens once.
//! Callers MUST go through `resolve_inside_workspace`; bypassing it is a bug.
//!
//! Symlink note (Phase D + Phase D.5):
//! - **Lexical resolve** (`resolve_inside_workspace`): for write-side commands
//!   (`new_file`, `new_folder`, `rename`, `move`, gitignore append, etc.) the
//!   target may not exist yet, so we resolve `..`/`.` lexically and check
//!   `starts_with(workspace_root)`. A symlink inside the workspace pointing
//!   outside is reachable — consistent with the prior sidecar behavior and
//!   with what users expect when they put a symlink in their own project.
//! - **Canonical resolve** (`resolve_existing_inside_workspace`): for read-side
//!   commands (`read_preview`, `download_file`) we canonicalize the resolved
//!   path AND the workspace root, then re-check `starts_with`. This blocks
//!   the "malicious repo with `evil_link → /etc/passwd`" attack: cloning a
//!   repo means the workspace root is trusted, but individual symlinks
//!   inside it are not. Read-only commands have no legitimate need to follow
//!   them outside.
//!
//! The same canonicalize trick can't apply to write-side commands because
//! `fs::canonicalize` fails on paths that don't exist yet.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

use crate::commands::validate_file_path as system_blacklist_check;

/// Errors are stringly-typed because Tauri commands serialize errors as strings
/// to the frontend; matching the existing error style avoids a translation layer.
pub type WfResult<T> = Result<T, String>;

/// Validate the workspace root itself: must be absolute, must not target a
/// blacklisted system / credential directory, must currently exist.
///
/// We require existence here (unlike validate_file_path which is read-only) so
/// that an invalid workspace_path can never silently create files in `/`.
pub fn validate_workspace_root(workspace_path: &str) -> WfResult<PathBuf> {
    let resolved = system_blacklist_check(workspace_path)?;
    if !resolved.is_dir() {
        return Err(format!(
            "Workspace path is not a directory or does not exist: {}",
            workspace_path
        ));
    }
    Ok(resolved)
}

/// Resolve a `relative` path inside `workspace_root`. The relative segment may
/// also be empty / "." — in which case the workspace root itself is returned.
///
/// Rules:
/// - `relative` MUST be relative (no leading `/` or drive letter).
/// - `..` is allowed inside the segment but cannot escape `workspace_root`.
/// - Resulting path is checked against the system blacklist as a final guard
///   (defense-in-depth in case the workspace itself sits next to a blacklisted
///   dir and the relative includes `../...`).
pub fn resolve_inside_workspace(workspace_root: &Path, relative: &str) -> WfResult<PathBuf> {
    if Path::new(relative).is_absolute() {
        return Err("Path must be relative to workspace root".to_string());
    }

    let mut resolved = workspace_root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::ParentDir => {
                if resolved == *workspace_root {
                    return Err("Path escapes workspace root".to_string());
                }
                resolved.pop();
            }
            Component::CurDir => {}
            Component::Normal(part) => resolved.push(part),
            Component::Prefix(_) | Component::RootDir => {
                return Err("Absolute / drive-letter components not allowed".to_string());
            }
        }
    }

    if !resolved.starts_with(workspace_root) {
        return Err("Path escapes workspace root".to_string());
    }

    // Final blacklist check — covers the case where the workspace itself is
    // adjacent to a sensitive dir and a malicious `relative` walked into it.
    if let Some(s) = resolved.to_str() {
        let _ = system_blacklist_check(s)?;
    }

    Ok(resolved)
}

/// Validate that an arbitrary absolute path (e.g. a file the user dragged from
/// Finder) is safe to read from. Used by `read_files_b64` and `copy_paths`.
///
/// Cross-review 0.2.33 (Codex Critical): the lexical blacklist alone is
/// defeated by an intermediate symlink component — `~/Downloads/lure/key`
/// where `lure → ~/.ssh` doesn't start with any blacklisted prefix, but the
/// read that follows traverses the link and exfiltrates credential bytes into
/// the AI-readable workspace. Canonicalize and re-run the blacklist on the
/// REAL path. This mirrors the fix `copy_internal_one` already got (5b72e25a);
/// before this, the two sibling copy commands had divergent trust models.
///
/// Returns the LEXICAL path (not the canonical one) so callers keep their
/// leaf-symlink semantics: `files_b64` rejects symlink leaves outright (its
/// extension allow-list checks the *name*, not the target) and `copy_paths`
/// reports them as unsupported — returning the canonical path would silently
/// resolve the leaf and re-open that hole.
///
/// A path that does NOT exist passes on the lexical check alone: the
/// symlink-escape defense is only meaningful for paths that resolve (a
/// non-existent path can't be read; `transfer`/`files_b64` stat it right
/// after and fail their own way), and `slash.rs` depends on validating a
/// brand-new workspace root that hasn't been created yet — failing here
/// would break the launcher's slash-command scan for new workspaces.
pub fn validate_external_read_path(absolute_path: &str) -> WfResult<PathBuf> {
    let lexical = system_blacklist_check(absolute_path)?;
    if let Ok(canonical) = fs::canonicalize(&lexical) {
        if let Some(s) = canonical.to_str() {
            let _ = system_blacklist_check(s)?;
        }
    }
    Ok(lexical)
}

/// Stricter variant of `resolve_inside_workspace` for **read-side** commands:
/// resolves any symlinks via `fs::canonicalize` and verifies the canonical
/// path is still inside the canonical workspace root — OR inside a trusted
/// MyAgents-managed directory (see `is_trusted_managed_target`). Blocks the
/// "malicious `evil_link → /etc/passwd` checked into a repo" attack from
/// leaking content out of the workspace, while still allowing the
/// junctions / symlinks we sync ourselves from `~/.myagents/skills` etc.
/// into `<workspace>/.claude/skills/` (see `agent-session.ts:syncProjectSkillSymlinks`).
///
/// Behavior:
/// - If the resolved path doesn't exist, returns `Err("File not found")` (the
///   read command was going to error anyway — surfacing the same error here
///   makes the failure mode uniform regardless of whether the path is missing
///   or rejected for being a symlink escape).
/// - If the path exists but resolves outside the workspace via symlink AND
///   isn't under a trusted MyAgents-managed root, returns
///   `Err("Path escapes workspace root via symlink")`.
/// - If the workspace root itself isn't canonicalizable (rare — race with
///   directory deletion), returns `Err("Workspace root canonicalize failed")`
///   rather than silently downgrading to lexical-only.
///
/// **Do not** use for write/create commands — `fs::canonicalize` fails on
/// paths that don't exist, so `new_file`/`new_folder` etc. must use the
/// lexical helper.
pub fn resolve_existing_inside_workspace(
    workspace_root: &Path,
    relative: &str,
) -> WfResult<PathBuf> {
    // Lexical pre-check first — same `..`/absolute/blacklist rules.
    let lexical = resolve_inside_workspace(workspace_root, relative)?;

    // Canonicalize the workspace root once. If this fails the workspace was
    // moved/deleted under us — fail closed rather than fall through.
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|_| "Workspace root canonicalize failed".to_string())?;

    // Canonicalize the candidate. Failure means the path doesn't exist (or is
    // unreadable for permission reasons) — the caller would surface an error
    // either way, so collapse this branch into a uniform "not found".
    let canonical = fs::canonicalize(&lexical).map_err(|_| "File not found".to_string())?;

    if !canonical.starts_with(&canonical_root)
        && !is_trusted_managed_target(&canonical, &trusted_managed_roots())
    {
        return Err("Path escapes workspace root via symlink".to_string());
    }

    Ok(canonical)
}

/// Canonicalized roots of MyAgents-managed directories that we sync into
/// workspaces via junctions/symlinks. Targets under any of these roots are
/// safe to follow from in-workspace links because MyAgents owns the source —
/// users can edit them through the Settings UI but they're not attacker-
/// controlled like an arbitrary file in a cloned repo.
///
/// Non-existent subdirs are skipped (some users won't have `agents/` etc.
/// yet). Result is recomputed each call rather than cached so newly-created
/// dirs become trusted without a sidecar restart; the work is three
/// `fs::canonicalize` calls, dwarfed by the file read that follows.
fn trusted_managed_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let myagents = home.join(".myagents");
    ["skills", "commands", "agents"]
        .iter()
        .filter_map(|sub| fs::canonicalize(myagents.join(sub)).ok())
        .collect()
}

/// Returns `true` iff `canonical` is inside one of the trusted roots. Pure
/// function so tests can inject their own root set via [`trusted_managed_roots`]
/// or a literal `Vec<PathBuf>`.
fn is_trusted_managed_target(canonical: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| canonical.starts_with(root))
}

/// Reject filenames that would break on Windows or hide the file (`.`, `..`,
/// names beginning with whitespace, names containing path separators, NTFS
/// reserved names, and the Windows reserved character set).
///
/// This is the Rust equivalent of the sidecar's `isValidItemName`.
pub fn validate_item_name(name: &str) -> WfResult<()> {
    if name.is_empty() || name.trim().is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name != name.trim() {
        return Err("Name cannot start or end with whitespace".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Name cannot contain path separators or '..'".to_string());
    }
    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err("Name contains invalid characters".to_string());
    }
    if name.chars().any(|c| (c as u32) < 0x20 || c == '\x7f') {
        return Err("Name contains control characters".to_string());
    }
    if name.chars().all(|c| c == '.') {
        return Err("Name cannot be only dots".to_string());
    }
    if is_windows_reserved_name(name) {
        return Err(format!("'{}' is a reserved Windows filename", name));
    }
    Ok(())
}

fn is_windows_reserved_name(name: &str) -> bool {
    // Windows silently strips trailing dots and spaces from filenames during
    // normalization, so `CON.`, `CON `, `CON. ` all resolve to the device
    // `CON`. Strip them before comparing the stem. (NUL bytes / control chars
    // in the stem are caught earlier by `validate_item_name`.)
    let stem_raw = name.split_once('.').map(|(s, _)| s).unwrap_or(name);
    let stem = stem_raw
        .trim_end_matches(|c: char| c == ' ' || c == '.')
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// Atomically write `bytes` to `target`. Writes a same-directory temp file
/// first, then `fs::rename`s it onto the target — `rename` is atomic on
/// POSIX (and Windows handles the dir-local case correctly). The temp name
/// is unique per process via a monotonic counter; `pid + counter` is enough
/// for the only realistic concurrency (one save modal per tab; AI CLAUDE.md
/// edits are sequential).
///
/// The target's parent must already exist (callers are responsible for
/// `create_dir_all` if their UX needs implicit-dir-create — `save_file.rs`
/// requires the file to exist anyway, so its parent does too).
pub fn atomic_write_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_file_inner(target, bytes, None)
}

/// Atomically write `bytes` only if the current target bytes still match
/// `expected_current`. The comparison runs after the tmp file is written and
/// immediately before the final rename, keeping stale autosaves from committing
/// over a newer external edit in the normal UI/AI interleaving.
pub fn atomic_write_file_if_current(
    target: &Path,
    bytes: &[u8],
    expected_current: &[u8],
) -> Result<(), String> {
    atomic_write_file_inner(target, bytes, Some(expected_current))
}

fn atomic_write_file_inner(
    target: &Path,
    bytes: &[u8],
    expected_current: Option<&[u8]>,
) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Cannot determine parent directory".to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Cannot determine filename".to_string())?
        .to_string_lossy()
        .to_string();

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(".{}.myagents-{}-{}.tmp", file_name, std::process::id(), n);
    let tmp_path = parent.join(&tmp_name);

    {
        let mut tmp_file =
            fs::File::create(&tmp_path).map_err(|e| format!("Failed to create tmp file: {}", e))?;
        tmp_file
            .write_all(bytes)
            .map_err(|e| format!("Failed to write tmp file: {}", e))?;
        // Drop the file handle before rename — Windows requires this.
    }

    if let Some(expected) = expected_current {
        let current = match read_prefix(target, expected.len().saturating_add(1)) {
            Ok(current) => current,
            Err(err) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(err);
            }
        };
        if current != expected {
            let _ = fs::remove_file(&tmp_path);
            return Err("File changed externally".to_string());
        }
    }

    if let Err(e) = fs::rename(&tmp_path, target) {
        // Best-effort cleanup so a failed rename doesn't leak a tmp file.
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to commit write: {}", e));
    }
    Ok(())
}

fn read_prefix(target: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(target).map_err(|_| "File not found".to_string())?;
    let mut current = Vec::with_capacity(max_bytes.min(64 * 1024));
    file.take(max_bytes as u64)
        .read_to_end(&mut current)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(current)
}

/// Read a regular file beneath `workspace_root` without following any path
/// component while it is opened. The returned bytes are bounded during the
/// read, so a file that grows after inspection cannot exhaust memory or cross
/// the caller's upload limit.
pub fn read_workspace_file_no_follow(
    workspace_root: &Path,
    requested: &str,
    max_bytes: u64,
) -> WfResult<(PathBuf, Vec<u8>)> {
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let lexical = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        resolve_inside_workspace(&canonical_root, requested)?
    };
    let lexical_metadata =
        fs::symlink_metadata(&lexical).map_err(|e| format!("Attachment not found: {}", e))?;
    if lexical_metadata.file_type().is_symlink() {
        return Err("Attachment path must not be a symlink".to_string());
    }
    if !lexical_metadata.is_file() {
        return Err("Attachment path must be a regular file".to_string());
    }
    let canonical =
        fs::canonicalize(&lexical).map_err(|e| format!("Attachment not found: {}", e))?;
    let relative = canonical
        .strip_prefix(&canonical_root)
        .map_err(|_| "Attachment path escapes the current workspace".to_string())?;
    if relative.as_os_str().is_empty() {
        return Err("Attachment path must be a regular file".to_string());
    }

    #[cfg(unix)]
    let mut file = open_relative_file_no_follow(&canonical_root, relative, false)?;
    #[cfg(not(unix))]
    let mut file = {
        let metadata = fs::symlink_metadata(&canonical)
            .map_err(|e| format!("Failed to inspect attachment: {}", e))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Attachment path must be a regular, non-symlink file".to_string());
        }
        fs::File::open(&canonical).map_err(|e| format!("Failed to open attachment: {}", e))?
    };
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened attachment: {}", e))?;
    if !metadata.is_file() {
        return Err("Attachment path must be a regular file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!("Attachment exceeds {} bytes", max_bytes));
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    (&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read attachment: {}", e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("Attachment exceeds {} bytes", max_bytes));
    }
    Ok((canonical, bytes))
}

/// Atomically write bytes beneath `workspace_root`. Parent components are
/// opened/created without following symlinks on Unix, the temp file uses
/// O_EXCL, and the final rename is relative to the verified parent handle.
pub fn write_workspace_file_no_follow(
    workspace_root: &Path,
    relative: &str,
    bytes: &[u8],
) -> WfResult<PathBuf> {
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let target = resolve_inside_workspace(&canonical_root, relative)?;
    let relative_path = target
        .strip_prefix(&canonical_root)
        .map_err(|_| "Path escapes workspace root".to_string())?;
    if relative_path.as_os_str().is_empty() || relative_path.file_name().is_none() {
        return Err("Destination filename is invalid".to_string());
    }

    #[cfg(unix)]
    {
        write_relative_file_no_follow_unix(&canonical_root, relative_path, bytes)?;
    }
    #[cfg(not(unix))]
    {
        write_relative_file_no_follow_portable(&canonical_root, relative_path, bytes)?;
    }
    Ok(target)
}

#[cfg(unix)]
fn component_cstring(component: &std::ffi::OsStr) -> WfResult<CString> {
    CString::new(component.as_bytes()).map_err(|_| "Path contains a NUL byte".to_string())
}

#[cfg(unix)]
fn open_relative_file_no_follow(
    root: &Path,
    relative: &Path,
    create_parents: bool,
) -> WfResult<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut root_options = fs::OpenOptions::new();
    root_options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let root_file = root_options
        .open(root)
        .map_err(|e| format!("Failed to open workspace root: {}", e))?;
    let mut opened_dirs = vec![root_file];
    let components = relative.components().collect::<Vec<_>>();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        let Component::Normal(name) = component else {
            return Err("Unsafe workspace path component".to_string());
        };
        let name = component_cstring(name)?;
        let parent_fd = opened_dirs
            .last()
            .expect("workspace root handle exists")
            .as_raw_fd();
        let mut fd = unsafe {
            libc::openat(
                parent_fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0
            && create_parents
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
        {
            let created = unsafe { libc::mkdirat(parent_fd, name.as_ptr(), 0o755) };
            if created < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(format!(
                    "Failed to create destination directory: {}",
                    std::io::Error::last_os_error()
                ));
            }
            fd = unsafe {
                libc::openat(
                    parent_fd,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            return Err(format!(
                "Workspace path contains an inaccessible or symlinked directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        opened_dirs.push(unsafe { fs::File::from_raw_fd(fd) });
    }
    let Some(Component::Normal(file_name)) = components.last() else {
        return Err("Destination filename is invalid".to_string());
    };
    let file_name = component_cstring(file_name)?;
    let fd = unsafe {
        libc::openat(
            opened_dirs
                .last()
                .expect("workspace parent handle exists")
                .as_raw_fd(),
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "Failed to open attachment: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn write_relative_file_no_follow_unix(root: &Path, relative: &Path, bytes: &[u8]) -> WfResult<()> {
    use std::os::unix::fs::OpenOptionsExt;

    let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
    let mut root_options = fs::OpenOptions::new();
    root_options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let root_file = root_options
        .open(root)
        .map_err(|e| format!("Failed to open workspace root: {}", e))?;
    let mut opened_dirs = vec![root_file];
    for component in parent_relative.components() {
        let Component::Normal(name) = component else {
            return Err("Unsafe destination path component".to_string());
        };
        let name = component_cstring(name)?;
        let parent_fd = opened_dirs.last().expect("root handle exists").as_raw_fd();
        let mut fd = unsafe {
            libc::openat(
                parent_fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            let created = unsafe { libc::mkdirat(parent_fd, name.as_ptr(), 0o755) };
            if created < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(format!(
                    "Failed to create destination directory: {}",
                    std::io::Error::last_os_error()
                ));
            }
            fd = unsafe {
                libc::openat(
                    parent_fd,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            return Err(format!(
                "Destination path contains a symlink or non-directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        opened_dirs.push(unsafe { fs::File::from_raw_fd(fd) });
    }
    let parent_fd = opened_dirs
        .last()
        .expect("parent handle exists")
        .as_raw_fd();
    verify_opened_workspace_parent(root, parent_relative, parent_fd)?;
    let leaf = component_cstring(relative.file_name().expect("leaf validated"))?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let stat_result = unsafe {
        libc::fstatat(
            parent_fd,
            leaf.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if stat_result == 0 && (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Err("Destination must not be a symlink or directory".to_string());
    }
    if stat_result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
        return Err(format!(
            "Failed to inspect destination: {}",
            std::io::Error::last_os_error()
        ));
    }

    for nonce in 0..100u32 {
        let temp_name = CString::new(format!(
            ".{}.myagents-{}-{}.tmp",
            relative
                .file_name()
                .expect("leaf validated")
                .to_string_lossy(),
            std::process::id(),
            nonce
        ))
        .map_err(|_| "Invalid destination filename".to_string())?;
        let fd = unsafe {
            libc::openat(
                parent_fd,
                temp_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists {
                continue;
            }
            return Err(format!(
                "Failed to create attachment temp file: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut temp = unsafe { fs::File::from_raw_fd(fd) };
        let write_result = temp.write_all(bytes).and_then(|_| temp.sync_all());
        drop(temp);
        if let Err(error) = write_result {
            unsafe { libc::unlinkat(parent_fd, temp_name.as_ptr(), 0) };
            return Err(format!("Failed to write attachment: {}", error));
        }
        if let Err(error) = verify_opened_workspace_parent(root, parent_relative, parent_fd) {
            unsafe { libc::unlinkat(parent_fd, temp_name.as_ptr(), 0) };
            return Err(error);
        }
        let renamed =
            unsafe { libc::renameat(parent_fd, temp_name.as_ptr(), parent_fd, leaf.as_ptr()) };
        if renamed < 0 {
            unsafe { libc::unlinkat(parent_fd, temp_name.as_ptr(), 0) };
            return Err(format!(
                "Failed to finalize attachment: {}",
                std::io::Error::last_os_error()
            ));
        }
        return Ok(());
    }
    Err("Failed to allocate attachment temp file".to_string())
}

#[cfg(unix)]
fn verify_opened_workspace_parent(root: &Path, relative: &Path, fd: libc::c_int) -> WfResult<()> {
    use std::os::unix::fs::MetadataExt;

    let current = fs::canonicalize(root.join(relative))
        .map_err(|e| format!("Destination parent changed while writing: {}", e))?;
    if !current.starts_with(root) {
        return Err("Destination parent escaped the workspace while writing".to_string());
    }
    let current_metadata = fs::metadata(&current)
        .map_err(|e| format!("Failed to inspect destination parent: {}", e))?;
    let mut opened: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut opened) } < 0 {
        return Err(format!(
            "Failed to inspect opened destination parent: {}",
            std::io::Error::last_os_error()
        ));
    }
    if current_metadata.dev() != opened.st_dev as u64
        || current_metadata.ino() != opened.st_ino as u64
    {
        return Err("Destination parent changed while writing".to_string());
    }
    Ok(())
}

#[cfg(all(not(unix), not(windows)))]
fn resolve_portable_destination_parent(root: &Path, relative_parent: &Path) -> WfResult<PathBuf> {
    let mut current = root.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(name) = component else {
            return Err("Unsafe workspace path component".to_string());
        };
        let verified_current = fs::canonicalize(&current)
            .map_err(|e| format!("Failed to resolve destination parent: {}", e))?;
        if !verified_current.starts_with(root) {
            return Err("Destination path escapes workspace via junction".to_string());
        }
        let candidate = current.join(name);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(
                        "Destination parent must contain only regular directories".to_string()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Create one component only after its parent has been verified.
                // `create_dir_all` here would traverse an unchecked junction and
                // could mutate a directory outside the workspace before rejection.
                fs::create_dir(&candidate)
                    .map_err(|e| format!("Failed to create destination directory: {}", e))?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect destination directory: {}",
                    error
                ));
            }
        }
        let canonical_candidate = fs::canonicalize(&candidate)
            .map_err(|e| format!("Failed to resolve destination parent: {}", e))?;
        if !canonical_candidate.starts_with(root) {
            return Err("Destination path escapes workspace via junction".to_string());
        }
        current = candidate;
    }
    fs::canonicalize(&current).map_err(|e| format!("Failed to resolve destination parent: {}", e))
}

#[cfg(all(not(unix), not(windows)))]
fn verify_portable_destination_parent(
    root: &Path,
    lexical_parent: &Path,
    expected: &Path,
) -> WfResult<()> {
    let current = fs::canonicalize(lexical_parent)
        .map_err(|e| format!("Destination parent changed while writing: {}", e))?;
    if !current.starts_with(root) || current != expected {
        return Err(
            "Destination parent changed or escaped the workspace while writing".to_string(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn replace_portable_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn open_windows_locked_directory(path: &Path) -> WfResult<fs::File> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Failed to lock destination directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    let file = unsafe { fs::File::from_raw_handle(handle as _) };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(format!(
            "Failed to inspect locked destination directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(
            "Destination parent must be a regular directory, not a junction or reparse point"
                .to_string(),
        );
    }
    Ok(file)
}

#[cfg(windows)]
fn resolve_windows_destination_parent(
    root: &Path,
    relative_parent: &Path,
) -> WfResult<(PathBuf, Vec<fs::File>)> {
    // Every retained handle omits FILE_SHARE_DELETE. Windows therefore cannot
    // rename/delete that directory while the write is in flight, closing the
    // validate-then-junction-swap window that path-only checks leave open.
    let mut locked = vec![open_windows_locked_directory(root)?];
    let mut current = root.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(name) = component else {
            return Err("Unsafe workspace path component".to_string());
        };
        let candidate = current.join(name);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(
                        "Destination parent must contain only regular directories".to_string()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // `current` is held without delete sharing, so this path cannot
                // be redirected to a different parent between check and create.
                match fs::create_dir(&candidate) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!("Failed to create destination directory: {}", error));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect destination directory: {}",
                    error
                ));
            }
        }
        let handle = open_windows_locked_directory(&candidate)?;
        let canonical_candidate = fs::canonicalize(&candidate)
            .map_err(|e| format!("Failed to resolve destination parent: {}", e))?;
        if !canonical_candidate.starts_with(root) {
            return Err("Destination path escapes workspace via junction".to_string());
        }
        locked.push(handle);
        current = candidate;
    }
    let canonical = fs::canonicalize(&current)
        .map_err(|e| format!("Failed to resolve destination parent: {}", e))?;
    Ok((canonical, locked))
}

#[cfg(all(not(unix), not(windows)))]
fn replace_portable_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn write_relative_file_no_follow_portable(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
) -> WfResult<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    let target = root.join(relative);
    let lexical_parent = target
        .parent()
        .ok_or_else(|| "Destination parent is invalid".to_string())?;
    let relative_parent = lexical_parent
        .strip_prefix(root)
        .map_err(|_| "Destination parent escapes workspace root".to_string())?;
    let (canonical_parent, _locked_directories) =
        resolve_windows_destination_parent(root, relative_parent)?;
    let canonical_target = canonical_parent.join(target.file_name().expect("leaf validated"));
    if let Ok(metadata) = fs::symlink_metadata(&canonical_target) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Destination must be a regular, non-symlink file".to_string());
        }
    }
    for nonce in 0..100u32 {
        let temp = canonical_parent.join(format!(
            ".{}.myagents-{}-{}.tmp",
            target
                .file_name()
                .expect("leaf validated")
                .to_string_lossy(),
            std::process::id(),
            nonce
        ));
        let mut options = fs::OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            // Omitting FILE_SHARE_DELETE keeps the newly created file from
            // being moved outside the locked workspace while bytes are written.
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
        let mut file = match options.open(&temp) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create attachment temp file: {}", error)),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temp);
            return Err(format!("Failed to write attachment: {}", error));
        }
        drop(file);
        if let Err(error) = replace_portable_file(&temp, &canonical_target) {
            let _ = fs::remove_file(&temp);
            return Err(format!("Failed to finalize attachment: {}", error));
        }
        return Ok(());
    }
    Err("Failed to allocate attachment temp file".to_string())
}

#[cfg(all(not(unix), not(windows)))]
fn write_relative_file_no_follow_portable(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
) -> WfResult<()> {
    let target = root.join(relative);
    let lexical_parent = target
        .parent()
        .ok_or_else(|| "Destination parent is invalid".to_string())?;
    let relative_parent = lexical_parent
        .strip_prefix(root)
        .map_err(|_| "Destination parent escapes workspace root".to_string())?;
    let canonical_parent = resolve_portable_destination_parent(root, relative_parent)?;
    let canonical_target = canonical_parent.join(target.file_name().expect("leaf validated"));
    if let Ok(metadata) = fs::symlink_metadata(&canonical_target) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Destination must be a regular, non-symlink file".to_string());
        }
    }
    for nonce in 0..100u32 {
        verify_portable_destination_parent(root, lexical_parent, &canonical_parent)?;
        let temp = canonical_parent.join(format!(
            ".{}.myagents-{}-{}.tmp",
            target
                .file_name()
                .expect("leaf validated")
                .to_string_lossy(),
            std::process::id(),
            nonce
        ));
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create attachment temp file: {}", error)),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&temp);
            return Err(format!("Failed to write attachment: {}", error));
        }
        drop(file);
        if let Err(error) =
            verify_portable_destination_parent(root, lexical_parent, &canonical_parent).and_then(
                |_| {
                    replace_portable_file(&temp, &canonical_target)
                        .map_err(|e| format!("Failed to finalize attachment: {}", e))
                },
            )
        {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        return Ok(());
    }
    Err("Failed to allocate attachment temp file".to_string())
}

/// Sanitize a filename for filesystem write — strips Windows-illegal chars by
/// replacing them with `_`. Different from `validate_item_name`, which rejects
/// rather than fixes (used at the API boundary for explicit user-typed names).
/// This one is for "user uploaded a file called `foo<bar>.pdf`" — fix not reject.
pub fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "untitled".to_string();
    }
    trimmed
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else if (c as u32) < 0x20 || c == '\x7f' {
                '_'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("path_safety")
    }

    #[test]
    fn rejects_relative_workspace_root() {
        assert!(validate_workspace_root("relative/path").is_err());
    }

    #[test]
    fn accepts_existing_dir() {
        let ws = make_tmp_workspace();
        let resolved = validate_workspace_root(ws.to_str().unwrap()).unwrap();
        assert_eq!(resolved, ws);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_blacklisted_dir() {
        // /etc exists on macOS/Linux; on Windows fall back to C:\Windows
        #[cfg(not(windows))]
        let blacklisted = "/etc";
        #[cfg(windows)]
        let blacklisted = "C:\\Windows";
        assert!(validate_workspace_root(blacklisted).is_err());
    }

    #[test]
    fn resolve_simple_relative() {
        let ws = make_tmp_workspace();
        let resolved = resolve_inside_workspace(&ws, "sub/file.txt").unwrap();
        assert_eq!(resolved, ws.join("sub").join("file.txt"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_dot_returns_root() {
        let ws = make_tmp_workspace();
        let resolved = resolve_inside_workspace(&ws, "").unwrap();
        assert_eq!(resolved, ws);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_absolute_relative() {
        let ws = make_tmp_workspace();
        assert!(resolve_inside_workspace(&ws, "/etc/passwd").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_traversal_escape() {
        let ws = make_tmp_workspace();
        assert!(resolve_inside_workspace(&ws, "../etc").is_err());
        assert!(resolve_inside_workspace(&ws, "a/../../etc").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn allows_internal_traversal() {
        let ws = make_tmp_workspace();
        // a/b/.. == a — legal
        let resolved = resolve_inside_workspace(&ws, "a/b/../c").unwrap();
        assert_eq!(resolved, ws.join("a").join("c"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validate_item_name_allows_unicode() {
        assert!(validate_item_name("说明.md").is_ok());
        assert!(validate_item_name("file_1-2.txt").is_ok());
    }

    #[test]
    fn validate_item_name_rejects_separators() {
        assert!(validate_item_name("a/b").is_err());
        assert!(validate_item_name("a\\b").is_err());
        assert!(validate_item_name("..").is_err());
    }

    #[test]
    fn validate_item_name_rejects_windows_reserved() {
        assert!(validate_item_name("CON").is_err());
        assert!(validate_item_name("con.txt").is_err());
        assert!(validate_item_name("LPT1.log").is_err());
    }

    // Cross-review regression guard: Windows normalizes `CON.`, `CON `,
    // `COM1   . ` etc. to the underlying device. The reserved-name check
    // must trim trailing dots/spaces before comparing the stem, otherwise a
    // user-typed name slips past validation but still resolves to the
    // device on Windows.
    #[test]
    fn validate_item_name_rejects_windows_reserved_with_trailing_chars() {
        assert!(validate_item_name("CON.").is_err());
        assert!(validate_item_name("CON ").is_err());
        assert!(validate_item_name("COM1.").is_err());
        assert!(validate_item_name("PRN. .").is_err());
        // Make sure regular names with trailing dot in stem still pass the
        // reserved-name gate (other rules may still reject them, but not
        // this one). `foo.txt` has stem "foo" which trims to "foo".
        // `foo.` has stem "foo" too — should pass reserved-name gate.
        assert!(validate_item_name("foo.").is_ok());
    }

    #[test]
    fn validate_item_name_rejects_control_chars() {
        assert!(validate_item_name("a\x00b").is_err());
        assert!(validate_item_name("\tfoo").is_err());
    }

    // validate_external_read_path: the canonical re-check only applies to
    // paths that EXIST. A non-existent path passes lexically — slash.rs
    // validates brand-new workspace roots before they're created (launcher
    // slash-command scan), and read flows stat right after anyway. The
    // 0.2.33 symlink hardening must not break that contract (caught by
    // align-docs reading the slash.rs caller comment).
    #[test]
    fn external_read_path_allows_nonexistent_path_lexically() {
        // NOT env::temp_dir(): on macOS that's /var/folders/… and the LEXICAL
        // blacklist rejects /var outright — use a non-existent child of a
        // real test workspace instead.
        let ws = make_tmp_workspace();
        let missing = ws.join("does_not_exist_yet");
        assert!(!missing.exists());
        assert!(validate_external_read_path(&missing.to_string_lossy()).is_ok());
        let _ = fs::remove_dir_all(&ws);
    }

    // …but an EXISTING path whose symlink chain lands in a blacklisted dir
    // is rejected on the canonical form (cross-review 0.2.33, Codex
    // Critical — the per-command test lives in transfer.rs).
    #[cfg(unix)]
    #[test]
    fn external_read_path_rejects_existing_symlink_into_blacklisted_dir() {
        use std::os::unix::fs::symlink;
        let staging = make_tmp_workspace();
        symlink("/etc", staging.join("lure")).unwrap();
        let evil = staging.join("lure").join("hosts");
        assert!(validate_external_read_path(&evil.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&staging);
    }

    // Rust side of the Rust↔renderer name-rule crosscheck (cross-review
    // 0.2.33, architecture review). The renderer's `workspace-tree/
    // nameValidation.ts` hand-mirrors this module's `validate_item_name` for
    // live editor feedback; both sides assert against the shared fixture so
    // a rule change on either side breaks one of the two suites — same
    // pattern as path-safety-blacklist.json (PRD 0.2.15 §7.2).
    #[test]
    fn validate_item_name_matches_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/shared/item-name-validation-cases.json"
        ))
        .expect("item-name-validation-cases.json parses");
        let names = |key: &str| -> Vec<String> {
            fixture[key]
                .as_array()
                .unwrap_or_else(|| panic!("fixture.{key} must be an array"))
                .iter()
                .map(|v| v.as_str().expect("fixture entry is a string").to_string())
                .collect()
        };
        for name in names("valid") {
            assert!(
                validate_item_name(&name).is_ok(),
                "fixture says {:?} is valid but validate_item_name rejected it",
                name
            );
        }
        for name in names("invalid") {
            assert!(
                validate_item_name(&name).is_err(),
                "fixture says {:?} is invalid but validate_item_name accepted it",
                name
            );
        }
    }

    #[test]
    fn sanitize_strips_illegal_chars() {
        assert_eq!(sanitize_filename("foo<bar>.pdf"), "foo_bar_.pdf");
        assert_eq!(sanitize_filename("a:b/c"), "a_b_c");
    }

    #[test]
    fn sanitize_falls_back_to_untitled() {
        assert_eq!(sanitize_filename(""), "untitled");
        assert_eq!(sanitize_filename("   "), "untitled");
    }

    #[test]
    fn atomic_write_if_current_cleans_tmp_when_current_read_fails() {
        let ws = make_tmp_workspace();
        let target = ws.join("missing.md");

        let res = atomic_write_file_if_current(&target, b"new content", b"old content");

        assert!(res.is_err());
        let leftovers: Vec<String> = fs::read_dir(&ws)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".myagents-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp leftovers: {:?}", leftovers);
        let _ = fs::remove_dir_all(&ws);
    }

    // ── resolve_existing_inside_workspace — Phase D.5 symlink hardening ──

    #[test]
    fn resolve_existing_finds_real_file() {
        let ws = make_tmp_workspace();
        fs::write(ws.join("foo.txt"), "x").unwrap();
        let resolved = resolve_existing_inside_workspace(&ws, "foo.txt").unwrap();
        // Both should canonicalize to the same path.
        assert_eq!(resolved, fs::canonicalize(ws.join("foo.txt")).unwrap());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_existing_rejects_missing() {
        let ws = make_tmp_workspace();
        let res = resolve_existing_inside_workspace(&ws, "nope.txt");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("File not found"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_existing_rejects_traversal() {
        let ws = make_tmp_workspace();
        let res = resolve_existing_inside_workspace(&ws, "../etc");
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // The headline regression guard: a malicious symlink inside the
    // workspace pointing outside (e.g. cloned repo with `evil_link → /etc`)
    // must be rejected by read-side commands. Lexical resolve passes — the
    // link IS at `<ws>/evil_link` which starts_with workspace — so we rely
    // on the canonicalize check to catch the escape.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        // Target outside the workspace.
        let outside_dir = std::env::temp_dir().join(format!("ws_outside_{}", std::process::id()));
        fs::create_dir_all(&outside_dir).unwrap();
        let outside_file = outside_dir.join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();
        // Symlink inside ws → outside file.
        symlink(&outside_file, ws.join("evil_link")).unwrap();

        let res = resolve_existing_inside_workspace(&ws, "evil_link");
        assert!(res.is_err());
        assert!(
            res.unwrap_err().contains("symlink"),
            "expected symlink-escape error"
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside_dir);
    }

    // Symlinks INSIDE the workspace pointing to other files INSIDE the
    // workspace should still be allowed — they're a legitimate user pattern
    // (e.g. linking `current → builds/v3`). Canonicalize collapses them but
    // both ends remain inside the canonical root.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_allows_internal_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        fs::write(ws.join("real.txt"), "ok").unwrap();
        symlink(ws.join("real.txt"), ws.join("link.txt")).unwrap();
        let resolved = resolve_existing_inside_workspace(&ws, "link.txt").unwrap();
        // Should resolve to the real file (canonicalize follows the link).
        assert_eq!(resolved, fs::canonicalize(ws.join("real.txt")).unwrap());
        let _ = fs::remove_dir_all(&ws);
    }

    // Broken symlink inside workspace — canonicalize fails → "File not found".
    // This is the right behavior: the read commands would error on read
    // anyway, and surfacing it here is uniform.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_handles_broken_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        symlink("/nonexistent/target", ws.join("broken")).unwrap();
        let res = resolve_existing_inside_workspace(&ws, "broken");
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn no_follow_workspace_io_rejects_symlink_ancestors_and_leafs() {
        use std::os::unix::fs::symlink;

        let ws = make_tmp_workspace();
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_outside_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, ws.join("linked")).unwrap();

        assert!(read_workspace_file_no_follow(&ws, "linked/secret.txt", 1024).is_err());
        assert!(write_workspace_file_no_follow(&ws, "linked/result.txt", b"blocked").is_err());
        assert!(!outside.join("result.txt").exists());

        symlink(outside.join("missing.txt"), ws.join("broken.txt")).unwrap();
        assert!(write_workspace_file_no_follow(&ws, "broken.txt", b"blocked").is_err());
        assert!(!outside.join("missing.txt").exists());
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn no_follow_workspace_writer_skips_precreated_temp_symlinks() {
        use std::os::unix::fs::symlink;

        let ws = make_tmp_workspace();
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_temp_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&outside).unwrap();
        let victim = outside.join("victim.txt");
        fs::write(&victim, "untouched").unwrap();
        let predictable = ws.join(format!(".result.txt.myagents-{}-0.tmp", std::process::id()));
        symlink(&victim, predictable).unwrap();

        write_workspace_file_no_follow(&ws, "result.txt", b"safe").unwrap();
        assert_eq!(fs::read(ws.join("result.txt")).unwrap(), b"safe");
        assert_eq!(fs::read(victim).unwrap(), b"untouched");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn no_follow_workspace_writer_atomically_replaces_an_existing_download() {
        let ws = make_tmp_workspace();
        write_workspace_file_no_follow(&ws, "downloads/result.txt", b"first").unwrap();
        write_workspace_file_no_follow(&ws, "downloads/result.txt", b"second").unwrap();
        assert_eq!(
            fs::read(ws.join("downloads/result.txt")).unwrap(),
            b"second"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(windows)]
    #[test]
    fn no_follow_workspace_writer_rejects_windows_junction_ancestors() {
        let ws = make_tmp_workspace();
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_windows_junction_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&outside).unwrap();
        junction::create(&outside, ws.join("linked")).unwrap();

        assert!(write_workspace_file_no_follow(&ws, "linked/result.txt", b"blocked").is_err());
        assert!(!outside.join("result.txt").exists());
        let _ = junction::delete(ws.join("linked"));
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    // ── is_trusted_managed_target — Phase E skill-junction whitelist ──

    #[test]
    fn trusted_target_matches_root() {
        let root = std::env::temp_dir().join(format!("trusted_root_{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let child = canonical_root.join("baoyu-imagine").join("SKILL.md");
        assert!(is_trusted_managed_target(&child, &[canonical_root.clone()]));
        // Sibling-of-prefix must NOT match — `starts_with` works on path
        // components, so `/tmp/trusted` does not pretend to contain
        // `/tmp/trusted_evil` even though the string starts the same.
        let evil = canonical_root.parent().unwrap().join(format!(
            "{}_evil",
            canonical_root.file_name().unwrap().to_string_lossy()
        ));
        assert!(!is_trusted_managed_target(&evil, &[canonical_root]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn trusted_target_empty_roots_rejects_everything() {
        // Defence: if `trusted_managed_roots()` returns empty (no `.myagents`
        // dir yet), the whitelist degrades closed — `is_trusted_managed_target`
        // returns false for any path so the original symlink-escape rejection
        // still fires.
        let p = Path::new("/anywhere");
        assert!(!is_trusted_managed_target(p, &[]));
    }

    // Headline whitelist test: a junction-like symlink in the workspace
    // pointing into a trusted root MUST resolve successfully even though the
    // target is outside the canonical workspace. This unblocks Windows users
    // hitting "文件预览失败" on user-level skill links synced by
    // `agent-session.ts:syncProjectSkillSymlinks`.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_allows_symlink_into_trusted_root() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        // Stand in for `~/.myagents/skills/`.
        let managed = std::env::temp_dir().join(format!("managed_skills_{}", std::process::id()));
        let managed_skill = managed.join("baoyu-imagine");
        fs::create_dir_all(&managed_skill).unwrap();
        let real_md = managed_skill.join("SKILL.md");
        fs::write(&real_md, "skill content").unwrap();

        // Mirror the prod symlink shape: `<ws>/.claude/skills/baoyu-imagine`
        // points at the managed skill dir.
        let link_parent = ws.join(".claude").join("skills");
        fs::create_dir_all(&link_parent).unwrap();
        symlink(&managed_skill, link_parent.join("baoyu-imagine")).unwrap();

        let canonical_managed = fs::canonicalize(&managed).unwrap();

        // Direct: bypass `trusted_managed_roots()` (which reads real
        // `~/.myagents/`) and inject our tmp root via the pure helper.
        let lexical =
            resolve_inside_workspace(&ws, ".claude/skills/baoyu-imagine/SKILL.md").unwrap();
        let canonical = fs::canonicalize(&lexical).unwrap();
        assert!(
            is_trusted_managed_target(&canonical, &[canonical_managed]),
            "skill target under managed root should be trusted: {:?}",
            canonical
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&managed);
    }
}
