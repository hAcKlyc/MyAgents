use myagents_agentnet_service::{initialize_identity_keys, serve_from_config};

#[tokio::main]
async fn main() {
    let mut args = std::env::args_os();
    let _program = args.next();
    let Some(flag) = args.next() else {
        eprintln!(
            "usage: myagents-agentnet-service (--config | --initialize-identity-keys) ABSOLUTE_PATH"
        );
        std::process::exit(2);
    };
    let Some(path) = args.next() else {
        eprintln!(
            "usage: myagents-agentnet-service (--config | --initialize-identity-keys) ABSOLUTE_PATH"
        );
        std::process::exit(2);
    };
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() || args.next().is_some() {
        eprintln!("invalid arguments");
        std::process::exit(2);
    }
    if flag == "--initialize-identity-keys" {
        if initialize_identity_keys(path).is_err() {
            eprintln!("AgentNet identity key initialization refused");
            std::process::exit(1);
        }
        return;
    }
    if flag != "--config" {
        eprintln!("invalid arguments");
        std::process::exit(2);
    }
    if serve_from_config(path).await.is_err() {
        eprintln!("AgentNet authentication service failed to start or stopped");
        std::process::exit(1);
    }
}
