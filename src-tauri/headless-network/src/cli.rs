use crate::{agent_network::NetworkError, auth, connector, owned, state::Owner, status};
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
        if key == "--join" {
            if options.insert(key, String::new()).is_some() {
                return Err(NetworkError::new("CLI_USAGE_INVALID"));
            }
            continue;
        }
        if ![
            "--state-dir",
            "--unit",
            "--credential",
            "--device-id",
            "--device-name",
            "--status-file",
            "--target-device-id",
            "--request-file",
            "--owned-instance",
            "--public-tls-ca-file",
            "--management-socket",
            "--management-host-uid",
            "--management-gid",
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
        if options.keys().any(|key| key.starts_with("--management-")) {
            return Err(NetworkError::new("CLI_USAGE_INVALID"));
        }
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
    let store = Arc::new(EncryptedIdentityStore::from_systemd(
        &root,
        &unit,
        &credential,
    )?);
    if let Some(origin) = options.get("--owned-instance") {
        if ![
            "owned-auth-start",
            "owned-auth-wait",
            "owned-auth-cancel",
            "owned-auth-logout",
            "owned-manage",
            "run",
        ]
        .contains(&command.as_str())
            || options.contains_key("--join") && command != "run"
        {
            return Err(NetworkError::new("CLI_USAGE_INVALID"));
        }
        let management_keys = [
            "--management-socket",
            "--management-host-uid",
            "--management-gid",
        ];
        let management_count = management_keys
            .iter()
            .filter(|key| options.contains_key(**key))
            .count();
        if management_count != 0 && (management_count != management_keys.len() || command != "run")
        {
            return Err(NetworkError::new("CLI_USAGE_INVALID"));
        }
        let management = if management_count == 0 {
            None
        } else {
            let parse_id = |key: &str| -> Result<u32, NetworkError> {
                let value = required(key)?;
                if value.is_empty()
                    || value.len() > 10
                    || !value.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err(NetworkError::new("CLI_USAGE_INVALID"));
                }
                value
                    .parse()
                    .ok()
                    .filter(|id: &u32| *id > 0)
                    .ok_or_else(|| NetworkError::new("CLI_USAGE_INVALID"))
            };
            Some(crate::management_ipc::ManagementIpcConfig {
                socket: PathBuf::from(required("--management-socket")?),
                host_uid: parse_id("--management-host-uid")?,
                management_gid: parse_id("--management-gid")?,
            })
        };
        if options.contains_key("--request-file") != (command == "owned-manage") {
            return Err(NetworkError::new("CLI_USAGE_INVALID"));
        }
        let _management_lock = if command == "owned-manage" {
            Some(status::run_lock(&root)?)
        } else {
            None
        };
        let ca = options.get("--public-tls-ca-file").map(PathBuf::from);
        let connection = if matches!(command.as_str(), "owned-auth-cancel" | "owned-auth-logout") {
            owned::Connection::from_pinned(origin, ca.as_deref(), store.clone(), &device)?
        } else {
            owned::Connection::discover(origin, ca.as_deref(), store.clone(), &device).await?
        };
        let path = options.get("--status-file").map(PathBuf::from);
        match command.as_str() {
            "owned-auth-start" => println!("{}", connection.start().await?),
            "owned-auth-wait" => {
                connection.wait().await?;
                println!("{}", serde_json::json!({"status":"authenticated"}));
            }
            "owned-auth-cancel" | "owned-auth-logout" => {
                connection.cancel().await?;
                println!("{}", serde_json::json!({"status":"signedOut"}));
            }
            "owned-manage" => {
                let response = crate::native_management::run(
                    &connection,
                    &PathBuf::from(required("--request-file")?),
                )
                .await?;
                println!(
                    "{}",
                    serde_json::to_string(&response)
                        .map_err(|_| NetworkError::new("HOST_MANAGEMENT_RESPONSE_INVALID"))?
                );
            }
            "run" => {
                let _lock = status::run_lock(&root)?;
                connector::run_owned(
                    Arc::new(Owner {
                        store,
                        device_id: device,
                    }),
                    &connection,
                    path.as_deref(),
                    options.contains_key("--join"),
                    management.as_ref(),
                )
                .await?;
            }
            _ => unreachable!("owned commands validated above"),
        }
        return Ok(());
    }
    if options.contains_key("--request-file")
        || options.contains_key("--public-tls-ca-file")
        || options.contains_key("--management-socket")
        || options.contains_key("--management-host-uid")
        || options.contains_key("--management-gid")
        || options.contains_key("--join")
        || command.starts_with("owned-")
    {
        return Err(NetworkError::new("CLI_USAGE_INVALID"));
    }
    let owner = Owner {
        store,
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
