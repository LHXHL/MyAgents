//! Windows credential-file DACL transport. The callers retain file lifecycle
//! and executable discovery; this leaf preserves their existing access policy.

#[cfg(windows)]
pub(crate) fn harden_windows_acl(
    path: &std::path::Path,
    powershell: &std::path::Path,
) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};

    let raw_path = path.to_str().ok_or("non-UTF8 credential path")?;
    let encoded_path = general_purpose::STANDARD.encode(raw_path.as_bytes());
    let script = format!(
        "$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_path}'))\n{}",
        include_str!("credential_acl.ps1")
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded_script = general_purpose::STANDARD.encode(utf16);
    let output = crate::process_cmd::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded_script,
        ])
        .output()
        .map_err(|error| format!("ACL helper spawn failed: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(acl_command_error(output.status.code(), &output.stderr))
    }
}

fn acl_command_error(code: Option<i32>, stderr: &[u8]) -> String {
    // Only accept the producer's typed receipt. Unexpected PowerShell bootstrap
    // output must not inject multiline CLIXML or credential paths into logs.
    let text = String::from_utf8_lossy(stderr);
    if let Some(line) = text
        .lines()
        .find(|line| line.starts_with("ACL_WRITE_FAILED "))
    {
        return line.to_owned();
    }
    format!("ACL helper exited with code {code:?}; no typed error receipt")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_keep_typed_cause_without_multiline_powershell_output() {
        let stderr = b"#< CLIXML\r\n<Objs>private path</Objs>\r\nACL_WRITE_FAILED type=System.UnauthorizedAccessException hresult=-2147024891\r\n";
        assert_eq!(
            acl_command_error(Some(1), stderr),
            "ACL_WRITE_FAILED type=System.UnauthorizedAccessException hresult=-2147024891"
        );
        assert_eq!(
            acl_command_error(Some(1), b"#< CLIXML\n<Objs>private path</Objs>"),
            "ACL helper exited with code Some(1); no typed error receipt"
        );
    }

    #[cfg(windows)]
    #[test]
    fn repeated_hardening_and_failure_receipts_work_without_audit_privileges() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("credential '中文'.json");
        std::fs::write(&path, "synthetic test fixture").unwrap();
        let powershell = crate::system_binary::find("powershell").unwrap();
        harden_windows_acl(&path, &powershell).unwrap();
        // Protected DACL is the historical shape that makes Set-Acl request
        // Audit/SACL privileges again under an ordinary non-elevated token.
        harden_windows_acl(&path, &powershell).unwrap();
        let missing = scratch.path().join("missing.json");
        let error = harden_windows_acl(&missing, &powershell).unwrap_err();
        assert!(error.starts_with("ACL_WRITE_FAILED type="));
        assert!(!error.contains("missing.json"));
    }
}
