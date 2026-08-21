/**
 * Start the Python vision service using the project's virtualenv.
 *
 * Resolving the interpreter here rather than in package.json keeps one script
 * working on Windows (.venv/Scripts) and POSIX (.venv/bin) alike, and lets the
 * missing-venv case explain itself instead of failing with ENOENT.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "server");
const isWindows = process.platform === "win32";

const python = path.join(
  serverDir,
  ".venv",
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python"
);

if (!existsSync(python)) {
  console.error("\n  The Python environment is missing.\n  Run:  npm run setup\n");
  process.exit(1);
}

const host = process.env.API_HOST ?? "127.0.0.1";
const port = process.env.API_PORT ?? "8000";
const args = ["-m", "uvicorn", "main:app", "--host", host, "--port", port];
if (process.argv.includes("--reload")) args.push("--reload");

const child = spawn(python, args, { cwd: serverDir, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
