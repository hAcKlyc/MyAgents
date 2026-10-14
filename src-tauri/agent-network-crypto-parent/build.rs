#[path = "build-support.rs"]
mod policy;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let source = manifest.parent().unwrap().join("agent-network-crypto");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed=build-support.rs");
    let mut provenance = String::new();
    let verified = policy::verified_inputs(|relative| fs::read(source.join(relative)))
        .expect("pinned reader source input validation failed");
    for &(relative, expected) in policy::INPUTS {
        let file = source.join(relative);
        println!("cargo:rerun-if-changed={}", file.display());
        provenance.push_str(&format!("{relative}:{expected}\n"));
    }
    // Compile only bytes already checked above; no later reads of source paths.
    let helper = policy::helper(std::str::from_utf8(&verified["src/macos_helper.rs"]).unwrap())
        .expect("parent policy source pattern changed");
    let helper_path = out.join("macos_helper.rs");
    fs::write(&helper_path, &helper).unwrap();
    let mut lib = String::from_utf8(verified["src/lib.rs"].clone()).unwrap();
    // Inner module docs cannot appear through include!. This changes comments only.
    lib = lib
        .lines()
        .map(|line| {
            line.strip_prefix("//!")
                .map(|text| format!("//{text}"))
                .unwrap_or_else(|| line.to_owned())
        })
        .collect::<Vec<_>>()
        .join("\n");
    for module in [
        "os_store",
        "macos_credential",
        "macos_helper",
        "encrypted_store",
    ] {
        let path = if module == "macos_helper" {
            helper_path.clone()
        } else {
            let relative = format!("src/{module}.rs");
            let path = out.join(format!("{module}.rs"));
            fs::write(&path, &verified[relative.as_str()]).unwrap();
            path
        };
        let pattern = format!("mod {module};");
        assert_eq!(
            lib.matches(&pattern).count(),
            1,
            "pinned module declaration changed"
        );
        let declaration = format!(
            "#[path = {}]\nmod {module};",
            serde_json::to_string(&path.to_str().unwrap()).unwrap()
        );
        lib = lib.replacen(&pattern, &declaration, 1);
    }
    fs::write(out.join("parent_crypto.rs"), &lib).unwrap();
    fs::write(
        out.join("parent-policy-provenance.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "patchVersion": policy::PATCH_VERSION,
            "sourceInputsSha256": digest(provenance.as_bytes()),
            "generatedHelperSha256": digest(helper.as_bytes()),
            "generatedLibSha256": digest(lib.as_bytes()),
            "backgroundBudgetSeconds": 30,
            "authorizationBudgetSeconds": 180,
            "readerSourceOrArtifactModified": false
        }))
        .unwrap(),
    )
    .unwrap();
}
