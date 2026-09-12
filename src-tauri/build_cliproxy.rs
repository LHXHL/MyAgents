//! Build inputs have a stricter source pin than runtime updates. Reuse the
//! resource signature trust root; verify the exact bundled target and bytes.
use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};

pub fn verify_bundle(app_version: &str, sdk_version: &str) {
    let platform = match (
        env::var("CARGO_CFG_TARGET_OS").as_deref(),
        env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
    ) {
        (Ok("macos"), Ok("aarch64")) => "darwin-arm64",
        (Ok("macos"), Ok("x86_64")) => "darwin-x64",
        (Ok("windows"), Ok("x86_64")) => "win32-x64",
        // Unsupported targets retain their existing app build; this provider
        // has no approved component there and is unavailable at runtime.
        _ => return,
    };
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/cliproxy");
    let source_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/managed-cliproxy-source.json");
    for path in [root.clone(), source_path.clone()] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-changed=src/resource_signature_core.rs");
    let read = |name: &str, limit: u64| {
        let path = root.join(name);
        let metadata = fs::symlink_metadata(&path).unwrap_or_else(|_| {
            panic!("Missing CLIProxy bundle {name}; run package-cliproxy-component.mjs stage")
        });
        assert!(
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= limit,
            "Invalid CLIProxy bundle file {name}"
        );
        fs::read(path).expect("read CLIProxy bundle")
    };
    let bytes = read("manifest-v1.json", 256 * 1024);
    let signature_bytes = read("manifest-v1.json.sig", 16 * 1024);
    let signature = std::str::from_utf8(&signature_bytes)
        .expect("CLIProxy signature text")
        .trim();
    crate::resource_signature::verify_minisign_bytes(
        &bytes,
        signature,
        "bundled CLIProxy manifest",
    )
    .expect("CLIProxy bundle must have a valid MyAgents resource signature");
    let manifest: serde_json::Value =
        serde_json::from_slice(&bytes).expect("CLIProxy manifest JSON");
    let source: serde_json::Value =
        serde_json::from_slice(&fs::read(source_path).expect("CLIProxy source pin"))
            .expect("source pin JSON");
    assert_eq!(manifest["schemaVersion"], 1, "CLIProxy manifest schema");
    let component = &manifest["component"];
    for key in ["version", "tag", "commit"] {
        assert_eq!(component[key], source[key], "CLIProxy source pin {key}");
    }
    assert_eq!(
        component["compatibility"]["sdkVersion"], sdk_version,
        "CLIProxy SDK compatibility"
    );
    assert!(
        component["compatibility"]["appVersions"]
            .as_array()
            .is_some_and(|versions| versions.iter().any(|v| v == app_version)),
        "CLIProxy App compatibility"
    );
    let artifact = &component["artifacts"][platform];
    assert_eq!(
        artifact["sourceSha256"], source["platforms"][platform]["sha256"],
        "CLIProxy upstream artifact pin"
    );
    let executable = if platform == "win32-x64" {
        "cli-proxy-api.exe"
    } else {
        "cli-proxy-api"
    };
    assert_eq!(
        artifact["executable"], executable,
        "CLIProxy target executable"
    );
    assert!(
        artifact["files"][executable].is_string() && artifact["files"]["LICENSE"].is_string(),
        "CLIProxy executable/license records"
    );
    let archive = read("artifact.zip", 128 * 1024 * 1024);
    assert_eq!(
        artifact["size"].as_u64(),
        Some(archive.len() as u64),
        "CLIProxy bundle size"
    );
    assert_eq!(
        artifact["sha256"].as_str(),
        Some(format!("{:x}", Sha256::digest(&archive)).as_str()),
        "CLIProxy bundle hash"
    );
}
