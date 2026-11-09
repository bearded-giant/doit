import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dataDir, paths, stateDir } from "./local.js";

const LABEL = "com.doit.doitd";
const DAEMON = fileURLToPath(new URL("./doitd.js", import.meta.url));
const xml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const quiet = (cmd, args) => {
    try {
        return run(cmd, args);
    } catch {
        return null;
    }
};
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Only paths go into the plist or unit: the sync token is read from $DOIT_STATE_DIR/token (0600),
// never from these world-readable files.
function env() {
    const out = { DOIT_DATA_DIR: dataDir(), DOIT_STATE_DIR: stateDir() };
    if (process.env.DOIT_SERVER_URL) out.DOIT_SERVER_URL = process.env.DOIT_SERVER_URL;
    return out;
}

const plistPath = () => path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const unitPath = () => path.join(os.homedir(), ".config/systemd/user/doitd.service");
const domain = () => `gui/${process.getuid()}`;

function writePlist() {
    const log = paths(stateDir()).log;
    const vars = Object.entries(env()).map(([k, v]) => `        <key>${k}</key>\n        <string>${xml(v)}</string>`).join("\n");
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(process.execPath)}</string>
        <string>${xml(DAEMON)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${vars}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
</dict>
</plist>
`);
}

function writeUnit() {
    const vars = Object.entries(env()).map(([k, v]) => `Environment=${k}=${v}`).join("\n");
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), `[Unit]
Description=doit daemon: single writer of the doit lists

[Service]
ExecStart=${process.execPath} ${DAEMON}
${vars}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`);
}

function bootstrap() {
    quiet("launchctl", ["bootout", `${domain()}/${LABEL}`]);
    for (let attempt = 1; ; attempt++) {
        try {
            run("launchctl", ["bootstrap", domain(), plistPath()]);
            return;
        } catch (err) {
            // bootout returns before launchd has torn the old job down; bootstrap gets EIO until it is gone
            if (attempt === 5) throw err;
            sleepSync(1000);
        }
    }
}

export function installService() {
    if (process.platform === "darwin") {
        writePlist();
        bootstrap();
        return `installed ${plistPath()}; log: ${paths(stateDir()).log}`;
    }
    writeUnit();
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "doitd"]);
    return `installed ${unitPath()}; logs: journalctl --user -u doitd`;
}

export function startService() {
    if (process.platform === "darwin") {
        if (!fs.existsSync(plistPath())) throw new Error(`${plistPath()} missing; run doit daemon install`);
        if (quiet("launchctl", ["print", `${domain()}/${LABEL}`]) === null) bootstrap();
        else run("launchctl", ["kickstart", `${domain()}/${LABEL}`]);
        return "doitd started";
    }
    run("systemctl", ["--user", "start", "doitd"]);
    return "doitd started";
}

export function stopService() {
    if (process.platform === "darwin") {
        quiet("launchctl", ["bootout", `${domain()}/${LABEL}`]);
        return "doitd stopped (launchd job unloaded; doit daemon start loads it again)";
    }
    run("systemctl", ["--user", "stop", "doitd"]);
    return "doitd stopped";
}

export function serviceStatus() {
    if (process.platform === "darwin") {
        if (!fs.existsSync(plistPath())) return "launchd: not installed (doit daemon install)";
        return quiet("launchctl", ["print", `${domain()}/${LABEL}`]) === null ? "launchd: installed, not loaded" : "launchd: loaded";
    }
    if (!fs.existsSync(unitPath())) return "systemd: not installed (doit daemon install)";
    return `systemd: ${quiet("systemctl", ["--user", "is-active", "doitd"]) || "inactive"}`;
}

export function tailLogs(lines = 50) {
    if (process.platform === "darwin") return quiet("tail", ["-n", String(lines), paths(stateDir()).log]) || "";
    return quiet("journalctl", ["--user", "-u", "doitd", "-n", String(lines), "--no-pager"]) || "";
}
