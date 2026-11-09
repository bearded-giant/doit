export async function getSetting(client, key, fallback = null) {
    const r = await client.query("select value from settings where key = $1", [key]);
    return r.rowCount ? r.rows[0].value : fallback;
}

export async function setSetting(client, key, value) {
    await client.query(
        "insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value",
        [key, JSON.stringify(value)],
    );
}
