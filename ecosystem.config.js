const path = require("path");

const isWindows = process.platform === "win32";
const python = path.join(
  __dirname, "server", ".venv",
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python"
);

module.exports = {
  apps: [
    {
      // Started first so the UI's health check passes immediately.
      name: "scanner-cv",
      script: python,
      args: "-m uvicorn main:app --host 127.0.0.1 --port 8000",
      cwd: path.join(__dirname, "server"),
      interpreter: "none",          // or PM2 tries to run python.exe with node
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      exp_backoff_restart_delay: 200,
      kill_timeout: 5000,
      time: true,
      out_file: path.join(__dirname, "logs", "cv-out.log"),
      error_file: path.join(__dirname, "logs", "cv-err.log"),
    },
    {
      name: "scanner-web",
      script: path.join(__dirname, "node_modules", "next", "dist", "bin", "next"),
      args: "start --port 3000",
      cwd: __dirname,
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      env: { NODE_ENV: "production" },
      time: true,
      out_file: path.join(__dirname, "logs", "web-out.log"),
      error_file: path.join(__dirname, "logs", "web-err.log"),
    },
  ],
};
