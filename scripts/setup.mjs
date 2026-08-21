/**
 * Create the Python virtualenv for the vision service and install its deps.
 * Safe to re-run: an existing venv is reused and the install is idempotent.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "server");
const isWindows = process.platform === "win32";
const venvPython = path.join(
  serverDir,
  ".venv",
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python"
);

const run = (cmd, args, label) => {
  console.log(`\n> ${label}`);
  const result = spawnSync(cmd, args, { cwd: serverDir, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`\n  Failed: ${label}`);
    process.exit(result.status ?? 1);
  }
};

/** Interpreters differ by platform, and `python3` is not always on PATH. */
function findSystemPython() {
  for (const candidate of isWindows ? ["python", "py", "python3"] : ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  console.error("\n  No Python interpreter found. Install Python 3.10 or newer and retry.\n");
  process.exit(1);
}

if (existsSync(venvPython)) {
  console.log("Virtualenv already present, reusing it.");
} else {
  run(findSystemPython(), ["-m", "venv", ".venv"], "creating server/.venv");
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "--quiet"], "upgrading pip");
run(venvPython, ["-m", "pip", "install", "-r", "requirements.txt"], "installing requirements");

console.log("\n  Ready. Start everything with:  npm run dev\n");
