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
            "--owned-policy-context-file",
            "--bot-execution-policy",
            "--bot-execution-socket",
            "--bot-node-uid",
            "--bot-ipc-gid",
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
    validate_context_option(&command, &options)?;
    validate_renew_options(&command, &options)?;
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
            "owned-management-renew",
            "run",
        ]
        .contains(&command.as_str())
            || options.contains_key("--join") && command != "run"
        {
            return Err(NetworkError::new("CLI_USAGE_INVALID"));
        }
        if command != "run" && options.keys().any(|key| key.starts_with("--bot-")) {
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
        let _management_lock =
            if matches!(command.as_str(), "owned-manage" | "owned-management-renew") {
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
            "owned-management-renew" => {
                let account = connection.account(false).await?;
                let changed = crate::management_admission::renew(&connection.owner, &account)?;
                println!(
                    "{}",
                    serde_json::json!({"status": if changed { "renewed" } else { "unchanged" }})
                );
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
                if let Some(file) = options.get("--owned-policy-context-file") {
                    connection.write_policy_context(&root, &PathBuf::from(file))?;
                }
                let fields = [
                    "--bot-execution-policy",
                    "--bot-execution-socket",
                    "--bot-node-uid",
                    "--bot-ipc-gid",
                ];
                let count = fields
                    .iter()
                    .filter(|key| options.contains_key(**key))
                    .count();
                let execution = if count == 0 {
                    None
                } else {
                    if count != fields.len() {
                        return Err(NetworkError::new("CLI_USAGE_INVALID"));
                    }
                    let policy = crate::bot_execution::FinitePolicy::load(&PathBuf::from(
                        required("--bot-execution-policy")?,
                    ))?;
                    let node_uid = required("--bot-node-uid")?
                        .parse::<u32>()
                        .map_err(|_| NetworkError::new("CLI_USAGE_INVALID"))?;
                    let ipc_gid = required("--bot-ipc-gid")?
                        .parse::<u32>()
                        .map_err(|_| NetworkError::new("CLI_USAGE_INVALID"))?;
                    let ipc = Arc::new(crate::bot_execution_ipc::BotExecutionIpc::bind(
                        &crate::bot_execution_ipc::BotExecutionIpcConfig {
                            socket: PathBuf::from(required("--bot-execution-socket")?),
                            node_uid,
                            ipc_gid,
                        },
                    )?);
                    Some(Arc::new(crate::bot_execution::BotExecution::new(
                        ipc, policy,
                    )?))
                };
                connector::run_owned(
                    Arc::new(Owner {
                        store,
                        device_id: device,
                    }),
                    &connection,
                    path.as_deref(),
                    options.contains_key("--join"),
                    execution,
                    management.as_ref(),
                )
                .await?;
            }
            _ => unreachable!("owned commands validated above"),
        }
        return Ok(());
    }
    if options.keys().any(|key| key.starts_with("--bot-"))
        || options.contains_key("--request-file")
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
fn validate_context_option(
    command: &str,
    options: &HashMap<String, String>,
) -> Result<(), NetworkError> {
    if options.contains_key("--owned-policy-context-file")
        && (command != "run" || !options.contains_key("--owned-instance"))
    {
        return Err(NetworkError::new("CLI_USAGE_INVALID"));
    }
    Ok(())
}
#[cfg(test)]
mod context_tests {
    use super::*;
    #[test]
    fn projection_only_belongs_to_owned_run() {
        let mut opts = HashMap::from([(
            "--owned-policy-context-file".into(),
            "/private/owned-policy-context.json".into(),
        )]);
        assert!(validate_context_option("run", &opts).is_err());
        opts.insert("--owned-instance".into(), "https://owned.invalid".into());
        assert!(validate_context_option("run", &opts).is_ok());
        for command in [
            "status",
            "owned-auth-start",
            "owned-auth-wait",
            "owned-auth-cancel",
            "owned-auth-logout",
            "owned-manage",
            "owned-policy-context",
        ] {
            assert!(validate_context_option(command, &opts).is_err());
        }
    }
}

fn validate_renew_options(
    command: &str,
    options: &HashMap<String, String>,
) -> Result<(), NetworkError> {
    if command == "owned-management-renew"
        && (!options.contains_key("--owned-instance")
            || options.keys().any(|key| {
                ![
                    "--state-dir",
                    "--unit",
                    "--credential",
                    "--device-id",
                    "--owned-instance",
                    "--public-tls-ca-file",
                    "--device-name",
                ]
                .contains(&key.as_str())
            }))
    {
        return Err(NetworkError::new("CLI_USAGE_INVALID"));
    }
    Ok(())
}

#[cfg(test)]
mod renewal_options_tests {
    use super::*;
    #[test]
    fn renew_options_are_closed_and_do_not_authorize_join_or_execution() {
        let mut options =
            HashMap::from([("--owned-instance".into(), "https://isolated.invalid".into())]);
        assert!(validate_renew_options("owned-management-renew", &options).is_ok());
        for flag in [
            "--join",
            "--management-socket",
            "--management-host-uid",
            "--management-gid",
            "--bot-execution-policy",
            "--status-file",
            "--request-file",
            "--target-device-id",
            "--owned-policy-context-file",
        ] {
            options.insert(flag.into(), "ignored".into());
            assert!(validate_renew_options("owned-management-renew", &options).is_err());
            options.remove(flag);
        }
        options.clear();
        assert!(validate_renew_options("owned-management-renew", &options).is_err());
    }
    #[test]
    fn renewal_and_daemon_share_the_same_exclusive_lock() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let lock = status::run_lock(&root).unwrap();
        assert!(status::run_lock(&root).is_err());
        drop(lock);
        assert!(status::run_lock(&root).is_ok());
    }
}
