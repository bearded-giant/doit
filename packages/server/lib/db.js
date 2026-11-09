import fs from "fs";
import { fileURLToPath } from "url";

let pool;

// Neon's driver speaks WebSocket (Node 22 has it built in); anything else is plain pg
export async function createPool(url) {
    if (/\.neon\.tech\b/.test(url)) {
        const { Pool } = await import("@neondatabase/serverless");
        return new Pool({ connectionString: url });
    }
    const { default: pg } = await import("pg");
    return new pg.Pool({ connectionString: url });
}

export async function getPool(url = process.env.DATABASE_URL) {
    if (pool) return pool;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = await createPool(url);
    return pool;
}

export function schemaSQL() {
    return fs.readFileSync(fileURLToPath(new URL("../schema/001_init.sql", import.meta.url)), "utf-8");
}

export async function migrate(client) {
    await client.query(schemaSQL());
}
