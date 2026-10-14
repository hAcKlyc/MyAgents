use minisign_verify::{PublicKey, Signature};
use std::{env, fs, io::Read, process};

fn verify() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 3 { return Err("usage: verifier ARCHIVE DECODED_PUBLIC_KEY DECODED_SIGNATURE".into()); }
    let key = PublicKey::from_file(&args[1])?;
    let signature = Signature::from_file(&args[2])?;
    // Streaming verifies both the archive signature and the trusted-comment global signature.
    // Legacy non-prehashed signatures are intentionally not accepted for new releases.
    let mut verifier = key.verify_stream(&signature)?;
    let mut file = fs::File::open(&args[0])?;
    let mut chunk = [0_u8; 65536];
    loop {
        let n = file.read(&mut chunk)?;
        if n == 0 { break; }
        verifier.update(&chunk[..n]);
    }
    verifier.finalize()?;
    Ok(())
}

fn main() {
    if let Err(error) = verify() {
        eprintln!("Update signature verification rejected: {error}");
        process::exit(1);
    }
    println!("Update signature verified");
}
