//! Isolated, checked Bellman transition verification. No contribution secrets.
//! Caller supplies immutable, independently hashed, size-limited local files.
use phase2::parameters::{verify_contribution, MPCParameters};
use std::{env, fs::File, io::{self, BufReader, Read, Seek, SeekFrom}, process};

// This preflight prevents attacker-controlled vector counts from causing large
// allocations before the upstream checked decoder sees a truncated input.
fn framing(file: &mut File, expected: u32) -> io::Result<()> {
    let size = file.metadata()?.len();
    let mut position = 576u64; // alpha1, beta1, beta2, gamma2, delta1, delta2
    for width in [64u64, 64, 64, 64, 64, 128] {
        file.seek(SeekFrom::Start(position))?;
        let mut count = [0u8; 4];
        file.read_exact(&mut count)?;
        position += 4 + u32::from_be_bytes(count) as u64 * width;
        if position > size { return Err(io::ErrorKind::InvalidData.into()); }
    }
    position += 64; // circuit digest
    file.seek(SeekFrom::Start(position))?;
    let mut count = [0u8; 4];
    file.read_exact(&mut count)?;
    if u32::from_be_bytes(count) != expected || position + 4 + expected as u64 * 384 != size {
        return Err(io::ErrorKind::InvalidData.into());
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(())
}

fn read(path: &str, expected: u32) -> io::Result<MPCParameters> {
    let mut file = File::open(path)?;
    if !file.metadata()?.is_file() { return Err(io::ErrorKind::InvalidData.into()); }
    framing(&mut file, expected)?;
    // Some fixed circuit query points are legitimately infinity. PublicKey::read
    // independently rejects infinity in ALL contribution proof points.
    let mut reader = BufReader::new(file);
    let params = MPCParameters::read(&mut reader, false, true)?;
    let mut extra = [0u8; 1];
    if reader.read(&mut extra)? != 0 { return Err(io::ErrorKind::InvalidData.into()); }
    Ok(params)
}

fn run() -> Result<(), ()> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 { return Err(()); }
    let count: u32 = args[3].parse().map_err(|_| ())?;
    if count >= 1_000_000 { return Err(()); }
    let before = read(&args[1], count).map_err(|_| ())?;
    let after = read(&args[2], count + 1).map_err(|_| ())?;
    let hash = verify_contribution(&before, &after).map_err(|_| ())?;
    // The sole success response is the independently verified public identifier.
    let hex: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
    println!("{hex}");
    Ok(())
}

fn main() {
    // Do not leak parser data through panic messages or third-party errors.
    std::panic::set_hook(Box::new(|_| {}));
    match std::panic::catch_unwind(run) {
        Ok(Ok(())) => {},
        Ok(Err(())) => process::exit(1),
        Err(_) => process::exit(2),
    }
}
