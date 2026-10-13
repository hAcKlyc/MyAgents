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
            "--owned-instance",
            "--bot-execution-policy",
            "--bot-execution-socket",
            "--bot-node-uid",
            "--bot-ipc-gid",
            "--public-tls-ca-file",
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
            "run",
        ]
        .contains(&command.as_str())
            || options.contains_key("--join") && command != "run"
        {
            return Err(NetworkError::new("CLI_USAGE_INVALID"));
        }
        if command!="run"&&options.keys().any(|key|key.starts_with("--bot-")){return Err(NetworkError::new("CLI_USAGE_INVALID"))}
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
            "run" => {
                let _lock = status::run_lock(&root)?;
                let fields=["--bot-execution-policy","--bot-execution-socket","--bot-node-uid","--bot-ipc-gid"];
                let count=fields.iter().filter(|key|options.contains_key(**key)).count();
                let execution=if count==0{None}else{
                    if count!=fields.len(){return Err(NetworkError::new("CLI_USAGE_INVALID"))}
                    let policy=crate::bot_execution::FinitePolicy::load(&PathBuf::from(required("--bot-execution-policy")?))?;
                    let node_uid=required("--bot-node-uid")?.parse::<u32>().map_err(|_|NetworkError::new("CLI_USAGE_INVALID"))?;
                    let ipc_gid=required("--bot-ipc-gid")?.parse::<u32>().map_err(|_|NetworkError::new("CLI_USAGE_INVALID"))?;
                    let ipc=Arc::new(crate::bot_execution_ipc::BotExecutionIpc::bind(&crate::bot_execution_ipc::BotExecutionIpcConfig{
                        socket:PathBuf::from(required("--bot-execution-socket")?),node_uid,ipc_gid})?);
                    Some(Arc::new(crate::bot_execution::BotExecution::new(ipc,policy)?))
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
                )
                .await?;
            }
            _ => unreachable!("owned commands validated above"),
        }
        return Ok(());
    }
    if options.keys().any(|key|key.starts_with("--bot-"))
        || options.contains_key("--public-tls-ca-file")
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
