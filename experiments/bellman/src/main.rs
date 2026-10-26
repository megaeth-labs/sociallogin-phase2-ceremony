//! Experimental native interop driver. Never used by ceremony acceptance.
use std::{env, process};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: moss-bellman-prototype contribute|verify INPUT OUTPUT");
        process::exit(2);
    }
    let result = match args[1].as_str() {
        "contribute" => {
            if std::path::Path::new(&args[3]).exists() {
                eprintln!("refusing to overwrite output");
                process::exit(2);
            }
            // The native library obtains 1024 bytes from OsRng internally.
            // No supplemental entropy is passed through argv, env, or logs.
            phase2::phase2::contribute(&args[2], &args[3], &String::new(), false, 0)
        }
        "verify" => phase2::phase2::verify_single_contribution(&args[2], &args[3]),
        _ => process::exit(2),
    };
    if let Err(error) = result {
        match error {
            phase2::utils::Phase2Error::IoError(e) => {
                eprintln!("Bellman I/O failure: {:?}", e.kind())
            }
            phase2::utils::Phase2Error::InvalidContribution(_) => {
                eprintln!("Bellman invalid contribution")
            }
            _ => eprintln!("Bellman synthesis failure"),
        }
        process::exit(1);
    }
}
