//! Cargo consumes the same committed package as npm without Node or private Git access.
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{env, fs, io::Read, path::PathBuf};

fn main() {
    let vendor = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../vendor/agent-network-protocol");
    let manifest_path = vendor.join("manifest.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("committed AgentNet protocol manifest"),
    )
    .expect("valid protocol manifest JSON");
    let version = manifest["version"].as_str().expect("protocol version");
    let digest = manifest["sha256"].as_str().expect("protocol digest");
    assert_eq!(manifest["package"], "@myagents/agent-network-protocol");
    assert_eq!(
        version,
        env!("CARGO_PKG_VERSION"),
        "Rust codec/protocol version mismatch"
    );
    assert!(digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()));
    let filename = format!(
        "myagents-agent-network-protocol-{version}-{}.tgz",
        &digest[..16]
    );
    assert_eq!(manifest["file"], filename, "invalid protocol filename");
    let archive_path = vendor.join(filename);
    println!("cargo:rerun-if-changed={}", archive_path.display());
    let bytes = fs::read(archive_path).expect("committed AgentNet protocol archive");
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        digest,
        "protocol checksum mismatch"
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for directory in ["schemas", "fixtures"] {
        let path = output.join(directory);
        if path.exists() {
            fs::remove_dir_all(path).expect("discard previous protocol projection");
        }
    }
    // Only flat JSON projection files are copied. Never unpack arbitrary tar paths.
    for entry in tar::Archive::new(GzDecoder::new(bytes.as_slice()))
        .entries()
        .expect("protocol tar")
    {
        let mut entry = entry.expect("protocol entry");
        let path = entry.path().expect("protocol entry path");
        let path = path.to_str().expect("UTF-8 protocol path");
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() != 3
            || parts[0] != "package"
            || !matches!(parts[1], "schemas" | "fixtures")
            || !parts[2].ends_with(".json")
        {
            continue;
        }
        assert!(
            parts[2]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.')),
            "protocol JSON filename must be a flat portable name"
        );
        assert!(
            entry.header().entry_type().is_file(),
            "protocol JSON must be a regular file"
        );
        let destination = output.join(parts[1]).join(parts[2]);
        let mut content = Vec::new();
        entry
            .read_to_end(&mut content)
            .expect("protocol JSON bytes");
        fs::create_dir_all(destination.parent().unwrap()).expect("protocol projection directory");
        fs::write(destination, content).expect("protocol projection write");
    }
}
