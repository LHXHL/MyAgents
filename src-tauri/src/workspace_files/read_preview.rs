//! Read a workspace file as text for the preview modal.
//!
//! Mirrors sidecar `/agent/file` semantics:
//!   * Resolve relative path inside workspace.
//!   * Reject if file doesn't exist.
//!   * Reject non-previewable types (binary / unknown — UI shows the modal
//!     only when content can be displayed as text).
//!   * Cap response at 2MB so a forgotten 50MB JSON doesn't pin the IPC
//!     channel.
//! Returns the same `{ content, name, size }` shape so DirectoryPanel's
//! `FilePreviewModal` consumer doesn't need a parallel branch.

use std::fs;
use std::io::Read;

use serde::Serialize;

use super::path_safety::{resolve_existing_inside_workspace, validate_workspace_root};
use super::system_open::validate_external_open_path;

// Text preview cap. 512KB was too tight for everyday text artifacts — `.jsonl`
// datasets, agent transcripts, logs and large JSON routinely exceed it, and the
// rejection surfaces in split-view as a "文件预览失败" toast that opens nothing
// (looks like the file "can't be previewed"). 2MB comfortably covers those while
// staying well within what Monaco's plaintext mode (forced for files >100KB,
// tokenizer off) renders smoothly. The bounded read below still guards against a
// file growing under us.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub content: String,
    pub name: String,
    pub size: u64,
}

/// Native browsing consumes a path, not the bounded source-text IPC payload.
#[tauri::command]
pub async fn cmd_workspace_resolve_preview_path(
    workspace: String,
    path: String,
) -> Result<String, String> {
    let root = validate_workspace_root(&workspace)?;
    let resolved = resolve_existing_inside_workspace(&root, path.trim())?;
    ensure_regular_readable_file(&resolved)?;
    Ok(crate::sidecar::normalize_external_path(resolved)
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn cmd_resolve_local_preview_path(full_path: String) -> Result<String, String> {
    let resolved = resolve_local_preview_path(&full_path)?;
    Ok(crate::sidecar::normalize_external_path(resolved)
        .to_string_lossy()
        .into_owned())
}

/// Also used at native browser admission, so a renderer path is never authority.
pub(crate) fn resolve_local_preview_path(full_path: &str) -> Result<std::path::PathBuf, String> {
    let resolved = validate_external_open_path(full_path.trim(), None)?;
    ensure_regular_readable_file(&resolved)?;
    Ok(resolved)
}

fn ensure_regular_readable_file(path: &std::path::Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Not a regular file".into());
    }
    // Opening checks OS readability without materializing any source bytes.
    fs::File::open(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_workspace_read_preview(
    workspace: String,
    path: String,
) -> Result<PreviewResult, String> {
    if path.trim().is_empty() {
        return Err("Missing path".to_string());
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    // resolve_existing_inside_workspace canonicalizes through any symlinks and
    // verifies the result stays inside workspace_root — blocks the
    // `evil_link → /etc/passwd` escape (Phase D.5).
    let resolved = resolve_existing_inside_workspace(&workspace_root, &path)?;
    read_preview_resolved(&resolved, &path)
}

/// Read an absolute local file as text for preview. Same cap and type gate as
/// workspace previews, but path validation follows the external-open surface:
/// existing absolute file under home/tmp/optional workspace, excluding
/// credential and system directories.
#[tauri::command]
pub async fn cmd_read_local_preview(
    full_path: String,
    workspace: Option<String>,
) -> Result<PreviewResult, String> {
    let trimmed = full_path.trim();
    if trimmed.is_empty() {
        return Err("Missing path".to_string());
    }
    let resolved = validate_external_open_path(trimmed, workspace.as_deref())?;
    read_preview_resolved(&resolved, trimmed)
}

fn read_preview_resolved(
    resolved: &std::path::Path,
    display_path: &str,
) -> Result<PreviewResult, String> {
    let metadata = fs::metadata(resolved).map_err(|_| "File not found".to_string())?;
    if !metadata.is_file() {
        return Err("Not a regular file".to_string());
    }

    let name = std::path::Path::new(display_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| display_path.to_string());

    if !is_previewable(&name) {
        return Err("File type not supported".to_string());
    }

    let size = metadata.len();
    if size > MAX_PREVIEW_BYTES {
        return Err(format!(
            "File too large for source preview ({} bytes; max {} MiB)",
            size,
            MAX_PREVIEW_BYTES / 1024 / 1024
        ));
    }

    // Bounded read — TOCTOU between the size check above and the read here:
    // the file may grow under us (active log, racing writer). Cap at MAX+1
    // bytes; if we hit MAX+1 the size check raced and we reject. Mirrors
    // `download.rs::cmd_workspace_download_file` which got this defense
    // earlier in the cross-review.
    let mut file = fs::File::open(resolved).map_err(|e| format!("Open failed: {}", e))?;
    let mut bytes = Vec::with_capacity(size as usize);
    let read_cap = MAX_PREVIEW_BYTES + 1;
    file.by_ref()
        .take(read_cap)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read {}: {}", display_path, e))?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err(format!(
            "File too large for source preview ({} bytes; max {} MiB)",
            bytes.len(),
            MAX_PREVIEW_BYTES / 1024 / 1024
        ));
    }
    let content =
        String::from_utf8(bytes).map_err(|e| format!("File is not valid UTF-8: {}", e))?;
    Ok(PreviewResult {
        content,
        name,
        size: size.min(MAX_PREVIEW_BYTES),
    })
}

/// Mirrors `src/shared/fileTypes.ts::isPreviewable`: **binary-blocklist** strategy.
/// Anything NOT a known binary extension is considered previewable; extensionless
/// names (Makefile, LICENSE, .gitignore, Caddyfile, etc.) are always previewable.
///
/// Cross-review caught the original allowlist as a real UX regression — sidecar
/// `isPreviewableText` falls through to this same blocklist via `isPreviewable`,
/// so the renderer's "show preview" gate and the Rust port's "allow read" gate
/// must agree. Set must stay in sync with `src/shared/fileTypes.ts` BINARY_EXTENSIONS.
fn is_previewable(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    // No dot, or a trailing dot with no real extension → extensionless file
    // (Makefile, LICENSE, `foo.`) — previewable. For dotfiles (`.zshrc`,
    // `.gitignore`) `rsplit_once` returns `("", "zshrc")` — `e` is non-empty
    // and we then check the binary blocklist, matching `src/shared/fileTypes.ts`
    // exactly: `.zshrc` is previewable (zshrc not binary), `.exe` is not
    // (exe in BINARY_EXTENSIONS).
    let ext = match lower.rsplit_once('.') {
        Some((_, e)) if !e.is_empty() => e,
        _ => return true,
    };
    !BINARY_EXTENSIONS.contains(&ext)
}

/// Keep in sync with `src/shared/fileTypes.ts::BINARY_EXTENSIONS`.
const BINARY_EXTENSIONS: &[&str] = &[
    // Images (superset of IMAGE_EXTENSIONS — includes raw/vector formats)
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif", "psd", "ai", "eps",
    "raw", "cr2", "nef", "heic", "heif", "avif", "jxl", // Video
    "mp4", "avi", "mov", "mkv", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp",
    // Audio
    "mp3", "wav", "aac", "ogg", "flac", "wma", "m4a", "opus", "aiff",
    // Archives / Compressed
    "zip", "tar", "gz", "bz2", "xz", "rar", "7z", "zst", "lz4", "lzma", "cab", "dmg", "iso",
    // Executables / Libraries
    "exe", "dll", "so", "dylib", "bin", "app", "msi", "deb", "rpm", "apk", "ipa",
    // Compiled / Object
    "o", "obj", "class", "pyc", "pyo", "wasm", "elc", // Fonts
    "ttf", "otf", "woff", "woff2", "eot", // Documents (binary formats)
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
    // Databases
    "db", "sqlite", "sqlite3", "mdb", // Other binary
    "dat", "ds_store", "swp", "swo",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;

    #[tokio::test]
    async fn browser_path_accepts_large_html_but_source_remains_bounded() {
        let ws = make_test_workspace("browser_large_html");
        let path = ws.join("大报告.html");
        let content = format!("<html><!--{}--></html>", "x".repeat(4_037_468));
        fs::write(&path, &content).unwrap();
        let workspace = ws.to_string_lossy().to_string();
        let target = cmd_workspace_resolve_preview_path(workspace.clone(), "大报告.html".into())
            .await
            .unwrap();
        assert_eq!(
            std::path::Path::new(&target),
            crate::sidecar::normalize_external_path(path.canonicalize().unwrap())
        );
        assert!(cmd_resolve_local_preview_path(target.clone()).await.is_ok());
        let error = cmd_workspace_read_preview(workspace, "大报告.html".into())
            .await
            .unwrap_err();
        assert!(error.contains(&content.len().to_string()));
        assert!(error.contains("max 2 MiB"));
        assert!(cmd_read_local_preview(target, None).await.is_err());
        fs::remove_dir_all(ws).unwrap();
    }

    #[tokio::test]
    async fn browser_path_rejects_traversal_missing_and_directory() {
        let ws = make_test_workspace("browser_path_guard");
        for path in ["../outside.html", "missing.html", ".", ""] {
            assert!(
                cmd_workspace_resolve_preview_path(ws.to_string_lossy().into(), path.into())
                    .await
                    .is_err(),
                "{path}"
            );
        }
        assert!(cmd_resolve_local_preview_path(ws.to_string_lossy().into())
            .await
            .is_err());
        fs::remove_dir_all(ws).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_path_preserves_workspace_containment_and_local_exclusions() {
        let ws = make_test_workspace("browser_symlink_guard");
        let outside = make_test_workspace("browser_symlink_outside");
        let html = outside.join("outside.html");
        fs::write(&html, "<html/>").unwrap();
        std::os::unix::fs::symlink(&html, ws.join("link.html")).unwrap();
        assert!(cmd_workspace_resolve_preview_path(
            ws.to_string_lossy().into(),
            "link.html".into()
        )
        .await
        .is_err());
        // An explicitly selected ordinary local target is a read-only lane.
        assert!(
            cmd_resolve_local_preview_path(html.to_string_lossy().into())
                .await
                .is_ok()
        );
        if std::path::Path::new("/etc/hosts").exists() {
            std::os::unix::fs::symlink("/etc/hosts", ws.join("secret.html")).unwrap();
            assert!(cmd_resolve_local_preview_path(
                ws.join("secret.html").to_string_lossy().into()
            )
            .await
            .is_err());
        }
        fs::remove_dir_all(ws).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[tokio::test]
    async fn source_preview_accepts_exact_byte_limit() {
        let ws = make_test_workspace("preview_exact_limit");
        fs::write(
            ws.join("limit.html"),
            "x".repeat(MAX_PREVIEW_BYTES as usize),
        )
        .unwrap();
        assert_eq!(
            cmd_workspace_read_preview(ws.to_string_lossy().into(), "limit.html".into())
                .await
                .unwrap()
                .content
                .len(),
            MAX_PREVIEW_BYTES as usize
        );
        fs::remove_dir_all(ws).unwrap();
    }

    #[tokio::test]
    async fn reads_text_file() {
        let ws = make_test_workspace("preview_text");
        fs::write(ws.join("hello.md"), "hi there").unwrap();
        let res =
            cmd_workspace_read_preview(ws.to_string_lossy().to_string(), "hello.md".to_string())
                .await
                .unwrap();
        assert_eq!(res.content, "hi there");
        assert_eq!(res.name, "hello.md");
        assert_eq!(res.size, 8);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn reads_local_text_file() {
        let ws = make_test_workspace("preview_local_text");
        let p = ws.join("outside.md");
        fs::write(&p, "local text").unwrap();

        let res = cmd_read_local_preview(p.to_string_lossy().to_string(), None)
            .await
            .unwrap();

        assert_eq!(res.content, "local text");
        assert_eq!(res.name, "outside.md");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_missing() {
        let ws = make_test_workspace("preview_missing");
        let res =
            cmd_workspace_read_preview(ws.to_string_lossy().to_string(), "nope.md".to_string())
                .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_non_previewable() {
        let ws = make_test_workspace("preview_binary");
        fs::write(ws.join("blob.bin"), b"\x00\x01\x02").unwrap();
        let res =
            cmd_workspace_read_preview(ws.to_string_lossy().to_string(), "blob.bin".to_string())
                .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_oversize() {
        let ws = make_test_workspace("preview_oversize");
        let big = "a".repeat((MAX_PREVIEW_BYTES + 1) as usize);
        fs::write(ws.join("big.md"), &big).unwrap();
        let res =
            cmd_workspace_read_preview(ws.to_string_lossy().to_string(), "big.md".to_string())
                .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let ws = make_test_workspace("preview_traversal");
        let res = cmd_workspace_read_preview(
            ws.to_string_lossy().to_string(),
            "../etc/hosts".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // Cross-review regression guards: the renderer side `isPreviewable` is a
    // BINARY blocklist (not text allowlist). The Rust gate must agree, otherwise
    // the user clicks a file the UI says is previewable and Rust returns "not
    // supported".
    #[tokio::test]
    async fn allows_extensionless_files() {
        let ws = make_test_workspace("preview_extless");
        for name in ["Makefile", "LICENSE", "Dockerfile", "Caddyfile"] {
            fs::write(ws.join(name), "content").unwrap();
            let res =
                cmd_workspace_read_preview(ws.to_string_lossy().to_string(), name.to_string())
                    .await;
            assert!(res.is_ok(), "{} should be previewable", name);
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn allows_dotfiles() {
        let ws = make_test_workspace("preview_dotfiles");
        for name in [".zshrc", ".gitconfig", ".npmrc", ".tool-versions"] {
            fs::write(ws.join(name), "content").unwrap();
            let res =
                cmd_workspace_read_preview(ws.to_string_lossy().to_string(), name.to_string())
                    .await;
            assert!(res.is_ok(), "{} should be previewable", name);
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn allows_unknown_text_extension() {
        let ws = make_test_workspace("preview_unknown_ext");
        fs::write(ws.join("data.weirdext"), "still text").unwrap();
        let res = cmd_workspace_read_preview(
            ws.to_string_lossy().to_string(),
            "data.weirdext".to_string(),
        )
        .await;
        assert!(
            res.is_ok(),
            "unknown extension should default to previewable"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    // Phase D.5 regression: a malicious repo containing a symlink to `/etc`
    // (or any out-of-workspace file) MUST NOT be readable through the
    // preview command. The lexical resolve passes (the symlink is at
    // `<ws>/evil_link` which starts_with workspace), so the canonicalize
    // check in `resolve_existing_inside_workspace` is the load-bearing gate.
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let ws = make_test_workspace("preview_symlink_escape");
        let outside = std::env::temp_dir().join(format!("preview_outside_{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        fs::write(&secret, "TOP SECRET").unwrap();
        symlink(&secret, ws.join("evil_link.txt")).unwrap();

        let res = cmd_workspace_read_preview(
            ws.to_string_lossy().to_string(),
            "evil_link.txt".to_string(),
        )
        .await;
        assert!(res.is_err());
        // Make sure the response does NOT contain the secret bytes — defense
        // against a future regression that returns content + error.
        assert!(!format!("{:?}", res).contains("TOP SECRET"));
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn rejects_known_binary_extensions() {
        let ws = make_test_workspace("preview_binary_ext");
        for name in ["app.exe", "vid.mp4", "music.mp3", "lib.so", "doc.docx"] {
            fs::write(ws.join(name), "fake").unwrap();
            let res =
                cmd_workspace_read_preview(ws.to_string_lossy().to_string(), name.to_string())
                    .await;
            assert!(res.is_err(), "{} should be rejected as binary", name);
        }
        let _ = fs::remove_dir_all(&ws);
    }
}
