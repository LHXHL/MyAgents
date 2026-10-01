//! Fuzzy file-name search inside a workspace, used by the `@` mention picker.
//!
//! Cheap walkdir + fuzzy_matcher scoring — does NOT use Tantivy. The Tantivy
//! index is full-text content search; for `@filename` autocomplete we want
//! fuzzy matching against names only, which is faster to build inline than
//! to express as a Tantivy query.
//!
//! Skips `.git`, `node_modules`, and dotfiles (matches existing sidecar
//! `/agent/search-files` behavior).

use std::path::PathBuf;

use fuzzy_matcher::skim::SkimMatcherV2;
use fuzzy_matcher::FuzzyMatcher;
use serde::Serialize;

use super::path_safety::validate_workspace_root;

const HARD_RESULT_LIMIT: usize = 20;
const HARD_DIR_DEPTH: usize = 8; // workspace recursion guard
const HARD_NODE_LIMIT: usize = 50_000; // walk-time guard for huge trees

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileSearchType {
    File,
    Dir,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    /// Path relative to workspace root, forward-slash separated for chat use.
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: FileSearchType,
}

#[tauri::command]
pub async fn cmd_workspace_search_files_fuzzy(
    workspace: String,
    query: String,
) -> Result<Vec<FileSearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    let query_owned = query;

    // Walk in a blocking task — skim's fuzzy matcher is sync, and `read_dir`
    // is sync. Keeping it on a blocking thread avoids hogging the runtime.
    tokio::task::spawn_blocking(move || walk_and_match(&workspace_root, &query_owned))
        .await
        .map_err(|e| format!("search task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_workspace_search_files_page(workspace: String, query: String, cursor: Option<String>, limit: usize) -> Result<crate::picker_page::PickerPage<FileSearchResult>, String> {
    let root = validate_workspace_root(&workspace)?;
    tokio::task::spawn_blocking(move || {
        let (items, partial) = snapshot(&root, &query)?;
        let scope = format!("{}\0{}", root.display(), query);
        crate::picker_page::page(items, &scope, cursor.as_deref(), limit, partial)
    }).await.map_err(|_| "PICKER_SEARCH_FAILED".to_string())?
}

fn walk_and_match(workspace_root: &PathBuf, query: &str) -> Result<Vec<FileSearchResult>, String> {
    let (mut items, _) = snapshot(workspace_root, query)?;
    items.truncate(HARD_RESULT_LIMIT);
    Ok(items)
}
fn snapshot(workspace_root: &PathBuf, query: &str) -> Result<(Vec<FileSearchResult>, bool), String> {
    let matcher = SkimMatcherV2::default().smart_case();
    let mut hits: Vec<(i64, FileSearchResult)> = Vec::new();
    let mut visited_nodes = 0usize;
    let mut partial = false;

    walk(
        workspace_root,
        workspace_root,
        0,
        &matcher,
        query,
        &mut hits,
        &mut visited_nodes,
        &mut partial,
    );

    if query.trim().is_empty() {
        hits.sort_by(|a, b| a.1.path.matches('/').count().cmp(&b.1.path.matches('/').count())
            .then(a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase())).then(a.1.path.cmp(&b.1.path)));
    } else {
        hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.path.len().cmp(&b.1.path.len())).then(a.1.path.cmp(&b.1.path)));
    }
    Ok((hits.into_iter().map(|(_, item)| item).collect(), partial))
}

fn walk(
    root: &PathBuf,
    current: &PathBuf,
    depth: usize,
    matcher: &SkimMatcherV2,
    query: &str,
    hits: &mut Vec<(i64, FileSearchResult)>,
    visited: &mut usize,
    partial: &mut bool,
) {
    if depth > HARD_DIR_DEPTH || *visited >= HARD_NODE_LIMIT {
        *partial = true;
        return;
    }
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => { *partial = true; return; },
    };
    for entry_result in entries {
        if *visited >= HARD_NODE_LIMIT {
            *partial = true;
            return;
        }
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => { *partial = true; continue; },
        };
        *visited += 1;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => { *partial = true; continue; },
        };
        if metadata.is_symlink() {
            // Skip symlinks defensively to avoid infinite loops via cycles.
            continue;
        }
        if let Some(score) = if query.trim().is_empty() { Some(0) } else { matcher.fuzzy_match(&name, query) } {
            let rel = path
                .strip_prefix(root)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| name.clone());
            hits.push((
                score,
                FileSearchResult {
                    path: rel,
                    name: name.clone(),
                    kind: if metadata.is_dir() {
                        FileSearchType::Dir
                    } else {
                        FileSearchType::File
                    },
                },
            ));
        }
        if metadata.is_dir() {
            walk(root, &path, depth + 1, matcher, query, hits, visited, partial);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("search")
    }

    #[tokio::test]
    async fn picker_pages_beyond_legacy_cap_and_detects_changed_snapshot() {
        let ws = make_tmp_workspace();
        for index in 0..30 { fs::write(ws.join(format!("file{index:02}.txt")), "").unwrap(); }
        let first = cmd_workspace_search_files_page(ws.to_string_lossy().into(), "file".into(), None, 5).await.unwrap();
        assert!(first.has_more); assert!(!first.complete);
        let rest = cmd_workspace_search_files_page(ws.to_string_lossy().into(), "file".into(), first.next_cursor.clone(), 200).await.unwrap();
        assert_eq!(rest.items.len(), 25); assert!(rest.complete);
        fs::write(ws.join("file-new.txt"), "").unwrap();
        assert_eq!(cmd_workspace_search_files_page(ws.to_string_lossy().into(), "file".into(), first.next_cursor, 200).await.unwrap_err(), "PICKER_CURSOR_STALE");
        let mut nested = ws.clone();
        for _ in 0..10 { nested = nested.join("nested"); fs::create_dir(&nested).unwrap(); }
        fs::write(nested.join("too-deep.txt"), "").unwrap();
        let limited = cmd_workspace_search_files_page(ws.to_string_lossy().into(), "".into(), None, 200).await.unwrap();
        assert!(limited.scan_limit_reached); assert!(!limited.complete);
        fs::remove_dir_all(ws).unwrap();
    }

    #[tokio::test]
    async fn finds_matching_file() {
        let ws = make_tmp_workspace();
        fs::write(ws.join("README.md"), "").unwrap();
        fs::write(ws.join("notes.md"), "").unwrap();
        let res =
            cmd_workspace_search_files_fuzzy(ws.to_string_lossy().to_string(), "rd".to_string())
                .await
                .unwrap();
        assert!(res.iter().any(|r| r.name == "README.md"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn empty_query_returns_empty() {
        let ws = make_tmp_workspace();
        fs::write(ws.join("a.txt"), "").unwrap();
        let res =
            cmd_workspace_search_files_fuzzy(ws.to_string_lossy().to_string(), "  ".to_string())
                .await
                .unwrap();
        assert!(res.is_empty());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn skips_node_modules_and_dotfiles() {
        let ws = make_tmp_workspace();
        fs::create_dir_all(ws.join("node_modules")).unwrap();
        fs::write(ws.join("node_modules").join("hidden.md"), "").unwrap();
        fs::write(ws.join(".env"), "").unwrap();
        fs::write(ws.join("visible.md"), "").unwrap();
        let res =
            cmd_workspace_search_files_fuzzy(ws.to_string_lossy().to_string(), "md".to_string())
                .await
                .unwrap();
        assert!(res.iter().any(|r| r.name == "visible.md"));
        assert!(!res.iter().any(|r| r.name == "hidden.md"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn finds_nested_file_with_relative_path() {
        let ws = make_tmp_workspace();
        fs::create_dir_all(ws.join("src").join("renderer")).unwrap();
        fs::write(ws.join("src").join("renderer").join("App.tsx"), "").unwrap();
        let res =
            cmd_workspace_search_files_fuzzy(ws.to_string_lossy().to_string(), "App".to_string())
                .await
                .unwrap();
        let hit = res.iter().find(|r| r.name == "App.tsx").unwrap();
        assert_eq!(hit.path, "src/renderer/App.tsx");
        let _ = fs::remove_dir_all(&ws);
    }
}
