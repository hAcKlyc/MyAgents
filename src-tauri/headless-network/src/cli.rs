use crate::{agent_network::NetworkError, auth, connector, state::Owner, status};
use myagents_agent_network_crypto::EncryptedIdentityStore;
use std::{collections::HashMap, path::PathBuf, sync::Arc};
pub async fn run() -> Result<(), String> {
    execute().await.map_err(|e| e.code)
}
async fn execute() -> Result<(), NetworkError> {
    let mut args = std::env::args().skip(1);
    let command = args
        .next()
        .ok_or_else(|| NetworkError::new("CLI_USAGE_INVALID"))?;
    let mut options = HashMap::new();
    while let Some(key) = args.next() {
        if ![
            "--state-dir",
            "--unit",
            "--credential",
            "--device-id",
            "--device-name",
            "--status-file",
            "--target-device-id",
        ]
        .contains(&key.as_str())
            || options.contains_key(&key)
        {
            return Err(NetworkError::new("CLI_USAGE_INVALID"));
        }
        options.insert(
            key,
            args.next()
                .ok_or_else(|| NetworkError::new("CLI_USAGE_INVALID"))?,
        );
    }
    let required = |key: &str| {
        options
            .get(key)
            .cloned()
            .ok_or_else(|| NetworkError::new("CLI_USAGE_INVALID"))
    };
    if command == "status" {
        let path = PathBuf::from(required("--status-file")?);
        println!("{}", status::read(&path)?);
        return Ok(());
    }
    let root = PathBuf::from(required("--state-dir")?);
    let unit = required("--unit")?;
    let credential = required("--credential")?;
    let device = required("--device-id")?;
    if uuid::Uuid::parse_str(&device)
        .map(|v| v.to_string())
        .as_deref()
        != Ok(device.as_str())
    {
        return Err(NetworkError::new("DEVICE_ID_INVALID"));
    }
    crate::device_identity::initialize(device.clone(), options.get("--device-name").cloned())
        .map_err(|_| NetworkError::new("DEVICE_ID_INVALID"))?;
    let owner = Owner {
        store: Arc::new(EncryptedIdentityStore::from_systemd(
            &root,
            &unit,
            &credential,
        )?),
        device_id: device,
    }
    .install()?;
    // The one-shot probe must not read account state while its run owner is active.
    let _probe_lock = if command == "probe-device-channel" {
        Some(status::run_lock(&root)?)
    } else {
        None
    };
    let (s, raw) = owner.read()?;
    if raw.is_none() {
        owner.commit(None, &s)?;
    }
    let path = options.get("--status-file").map(PathBuf::from);
    match command.as_str() {
        "auth-start" => println!("{}", auth::start(&owner).await?),
        "auth-wait" => {
            auth::wait(&owner).await?;
            println!("{}", serde_json::json!({"status":"authenticated"}));
        }
        "auth-cancel" => {
            owner.cancel()?;
            println!("{}", serde_json::json!({"status":"cancelled"}));
        }
        "probe-device-channel" => {
            let target = required("--target-device-id")?;
            if uuid::Uuid::parse_str(&target)
                .map(|v| v.to_string())
                .as_deref()
                != Ok(target.as_str())
            {
                return Err(NetworkError::new("TARGET_DEVICE_INVALID"));
            }
            let result = crate::probe::run(owner, &target).await?;
            println!(
                "{}",
                serde_json::to_string(&result)
                    .map_err(|_| NetworkError::new("PROBE_RESULT_INVALID"))?
            );
        }
        "run" => {
            let _lock = status::run_lock(&root)?;
            connector::run(owner, path.as_deref()).await?;
        }
        _ => return Err(NetworkError::new("CLI_USAGE_INVALID")),
    }
    Ok(())
}
