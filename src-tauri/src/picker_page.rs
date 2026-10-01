//! Stateless pages of a bounded owner snapshot. Cursors cannot silently skip
//! changed results or be reused for another workspace/query.
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerPage<T> {
    pub items: Vec<T>,
    pub has_more: bool,
    pub complete: bool,
    pub scan_limit_reached: bool,
    pub next_cursor: Option<String>,
}

pub fn page<T: Serialize>(
    items: Vec<T>,
    scope: &str,
    cursor: Option<&str>,
    limit: usize,
    scan_limit_reached: bool,
) -> Result<PickerPage<T>, String> {
    if !(1..=200).contains(&limit) {
        return Err("PICKER_PAGE_LIMIT_INVALID".into());
    }
    let mut hash = Sha256::new();
    hash.update(scope.as_bytes());
    hash.update([0]);
    serde_json::to_writer(&mut HashWriter(&mut hash), &items)
        .map_err(|_| "PICKER_SNAPSHOT_INVALID")?;
    hash.update([u8::from(scan_limit_reached)]);
    let fingerprint = format!("{:x}", hash.finalize());
    let offset = match cursor {
        None => 0,
        Some(value) => {
            let (digest, offset) = value.split_once(':').ok_or("PICKER_CURSOR_INVALID")?;
            if digest != fingerprint {
                return Err("PICKER_CURSOR_STALE".into());
            }
            offset
                .parse::<usize>()
                .map_err(|_| "PICKER_CURSOR_INVALID")?
        }
    };
    if offset > items.len() {
        return Err("PICKER_CURSOR_INVALID".into());
    }
    let end = offset.saturating_add(limit).min(items.len());
    let has_more = end < items.len();
    Ok(PickerPage {
        items: items.into_iter().skip(offset).take(limit).collect(),
        has_more,
        complete: !has_more && !scan_limit_reached,
        scan_limit_reached,
        next_cursor: has_more.then(|| format!("{fingerprint}:{end}")),
    })
}
struct HashWriter<'a>(&'a mut Sha256);
impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_all_hits_and_rejects_changed_or_cross_query_cursors() {
        let first = page((0..25).collect(), "ws/query", None, 5, false).unwrap();
        assert!(!first.complete);
        assert!(first.has_more);
        let cursor = first.next_cursor.as_deref();
        let rest = page((0..25).collect(), "ws/query", cursor, 200, false).unwrap();
        assert_eq!(rest.items, (5..25).collect::<Vec<_>>());
        assert!(rest.complete);
        assert_eq!(
            page((0..26).collect(), "ws/query", cursor, 5, false).unwrap_err(),
            "PICKER_CURSOR_STALE"
        );
        assert!(page((0..25).collect(), "other/query", cursor, 5, false).is_err());
    }
    #[test]
    fn scan_cutoff_is_not_all_results() {
        let result = page(vec![1], "ws", None, 5, true).unwrap();
        assert!(!result.complete);
        assert!(!result.has_more);
        assert!(result.scan_limit_reached);
    }
}
