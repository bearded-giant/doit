import { createHash, randomBytes, randomUUID } from "crypto";

export const hashToken = token => createHash("sha256").update(token).digest("hex");

// the machine name becomes every op's host
export async function authenticate(client, authorization) {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization || "");
    if (!m) return null;
    const r = await client.query("select machine from tokens where hash = $1 and revoked_at is null", [hashToken(m[1])]);
    return r.rowCount ? r.rows[0].machine : null;
}

// printed once; only the hash is stored
export async function mintToken(client, machine) {
    const token = randomBytes(32).toString("hex");
    await client.query(
        `insert into tokens (id, machine, hash) values ($1, $2, $3)
         on conflict (machine) do update set hash = excluded.hash, revoked_at = null, created_at = now()`,
        [randomUUID(), machine, hashToken(token)],
    );
    return token;
}

export async function revokeToken(client, machine) {
    const r = await client.query("update tokens set revoked_at = now() where machine = $1 and revoked_at is null", [machine]);
    return r.rowCount > 0;
}

export async function listTokens(client) {
    const r = await client.query("select machine, created_at, revoked_at from tokens order by machine");
    return r.rows;
}
