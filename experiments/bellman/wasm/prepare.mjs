// Fetch pinned public source and apply two explicit WASM build fixes.
// Refuses existing destinations rather than rewriting a researcher's checkout.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "source");
try { await access(source); throw new Error("source already exists; preserve or remove it deliberately"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
execFileSync("git", ["clone", "--no-checkout", "https://github.com/MystenLabs/phase2-bn254", source], { stdio: "ignore" });
execFileSync("git", ["checkout", "--detach", "f10c8a41ae019fb68c66fae0276159900b3a128c"], { cwd: source, stdio: "ignore" });
async function replace(file, before, after) {
  const path = join(source, file);
  const text = await readFile(path, "utf8");
  if (text.split(before).length !== 2) throw new Error(`patch context mismatch: ${file}`);
  await writeFile(path, text.replace(before, after));
}
await replace("phase2/Cargo.toml", 'bellman_ce = { path = "../bellman" }',
  'bellman_ce = { path = "../bellman", default-features = false }');
await replace("bellman/src/lib.rs", "        (total - 1) / num_cpus::get() + 1",
  '        #[cfg(feature = "multicore")]\n        { (total - 1) / num_cpus::get() + 1 }\n        #[cfg(not(feature = "multicore"))]\n        { total }');
console.log("Prepared pinned Rust source with explicit single-thread WASM build fixes.");
