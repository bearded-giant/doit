import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "doit-home-"));
process.env.HOME = home;
delete process.env.DOIT_SERVER_URL;
delete process.env.DOIT_SYNC_INTERVAL_MS;

const { installService, serviceEnv } = await import("./service.js");
const { syncConfig } = await import("./sync.js");

// a fresh machine installs local-only at the default pull interval
assert.equal(serviceEnv().DOIT_SERVER_URL, undefined);
assert.equal(serviceEnv().DOIT_SYNC_INTERVAL_MS, undefined);
assert.equal(syncConfig({}).interval, 10000);

// the installed unit, as a reinstall finds it on either platform
const plist = path.join(home, "Library/LaunchAgents/com.doit.doitd.plist");
const unit = path.join(home, ".config/systemd/user/doitd.service");
fs.mkdirSync(path.dirname(plist), { recursive: true });
fs.mkdirSync(path.dirname(unit), { recursive: true });
fs.writeFileSync(plist, "<dict>\n<key>DOIT_SERVER_URL</key>\n        <string>https://s.example/a?b=1&amp;c=2</string>\n<key>DOIT_SYNC_INTERVAL_MS</key>\n<string>3600000</string>\n</dict>\n");
fs.writeFileSync(unit, "[Service]\nEnvironment=DOIT_SERVER_URL=https://s.example/a?b=1&c=2\nEnvironment=DOIT_SYNC_INTERVAL_MS=3600000\nRestart=always\n");

// unset: a reinstall keeps the installed settings, so a syncing daemon never drops to local-only by accident
assert.equal(serviceEnv().DOIT_SERVER_URL, "https://s.example/a?b=1&c=2");
assert.equal(serviceEnv().DOIT_SYNC_INTERVAL_MS, "3600000");

// set: the new value wins
process.env.DOIT_SERVER_URL = "https://other.example";
assert.equal(serviceEnv().DOIT_SERVER_URL, "https://other.example");
assert.equal(serviceEnv().DOIT_SYNC_INTERVAL_MS, "3600000");

// set empty: the setting goes away
process.env.DOIT_SERVER_URL = "";
process.env.DOIT_SYNC_INTERVAL_MS = "";
assert.equal(serviceEnv().DOIT_SERVER_URL, undefined);
assert.equal(serviceEnv().DOIT_SYNC_INTERVAL_MS, undefined);

process.env.DOIT_SYNC_INTERVAL_MS = "60000";
assert.equal(syncConfig({}).interval, 60000);
process.env.DOIT_SYNC_INTERVAL_MS = "nonsense";
assert.equal(syncConfig({}).interval, 10000);

// linux: a reinstall restarts a running daemon, or it keeps the env it started with
const bin = path.join(home, "bin");
const calls = path.join(home, "systemctl.log");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${calls}\n`, { mode: 0o755 });
const realPath = process.env.PATH;
const realPlatform = process.platform;
process.env.PATH = `${bin}:${realPath}`;
Object.defineProperty(process, "platform", { value: "linux" });
try {
    installService();
} finally {
    Object.defineProperty(process, "platform", { value: realPlatform });
    process.env.PATH = realPath;
}
assert.deepEqual(fs.readFileSync(calls, "utf-8").trim().split("\n"), ["--user daemon-reload", "--user enable doitd", "--user restart doitd"]);

fs.rmSync(home, { recursive: true, force: true });
console.log("service: ok");
