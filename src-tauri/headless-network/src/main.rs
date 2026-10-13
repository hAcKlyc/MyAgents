#[tokio::main]
async fn main() {
    if let Err(error) = myagents_host_network::cli::run().await {
        eprintln!("{}", serde_json::json!({"status":"error","code":error}));
        std::process::exit(1);
    }
}
