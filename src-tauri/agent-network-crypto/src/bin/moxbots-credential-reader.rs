//! Private signed App component. No public credential CLI or GUI startup.
fn main() {
    #[cfg(target_os = "macos")]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        std::process::exit(
            myagents_agent_network_crypto::run_private_credential_helper(&args).unwrap_or(2),
        );
    }
    #[cfg(not(target_os = "macos"))]
    std::process::exit(2);
}
