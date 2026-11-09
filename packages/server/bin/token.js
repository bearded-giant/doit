#!/usr/bin/env node

// doit-server-token add|revoke|list [machine]   (DATABASE_URL names the server's Postgres)

import { getPool, migrate } from "../lib/db.js";
import { listTokens, mintToken, revokeToken } from "../lib/auth.js";

const [verb, machine] = process.argv.slice(2);
const usage = "usage: doit-server-token add <machine> | revoke <machine> | list";

const pool = await getPool();
const client = await pool.connect();
try {
    await migrate(client);
    if (verb === "add" && machine) {
        const token = await mintToken(client, machine);
        console.log(`token for ${machine} (shown once; store it in $DOIT_STATE_DIR/token, mode 0600):\n${token}`);
    } else if (verb === "revoke" && machine) {
        console.log((await revokeToken(client, machine)) ? `revoked ${machine}` : `no live token for ${machine}`);
    } else if (verb === "list") {
        for (const t of await listTokens(client)) {
            console.log(`${t.machine}\t${t.revoked_at ? `revoked ${t.revoked_at.toISOString()}` : `active since ${t.created_at.toISOString()}`}`);
        }
    } else {
        console.error(usage);
        process.exitCode = 1;
    }
} finally {
    client.release();
    await pool.end();
}
