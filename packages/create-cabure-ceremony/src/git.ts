import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

export interface CommandRunner {
  (command: string, args: string[], cwd: string): Promise<void>;
}

/**
 * Best-effort git initialization for generated projects.
 *
 * Returns false when git is unavailable or initialization fails so the wizard
 * can continue without breaking the scaffold flow.
 */
export async function initializeGitRepository(
  projectDirectory: string,
  runCommand: CommandRunner = runCommandInDirectory,
): Promise<boolean> {
  const gitDirectory = path.join(projectDirectory, ".git");
  if (await directoryExists(gitDirectory)) {
    return true;
  }

  try {
    await runCommand("git", ["init"], projectDirectory);
  } catch {
    return false;
  }

  return directoryExists(gitDirectory);
}

async function runCommandInDirectory(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const targetStats = await stat(targetPath);
    return targetStats.isDirectory();
  } catch {
    return false;
  }
}
