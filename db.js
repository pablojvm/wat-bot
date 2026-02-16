import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : undefined,
});

export async function getSession(clientId, from) {
  const { rows } = await pool.query(
    "select lead from sessions where client_id=$1 and wa_from=$2",
    [clientId, from]
  );
  return rows[0]?.lead || {};
}

export async function saveSession(clientId, from, leadObj) {
  await pool.query(
    `
    insert into sessions (client_id, wa_from, lead, updated_at)
    values ($1, $2, $3::jsonb, now())
    on conflict (client_id, wa_from)
    do update set lead=excluded.lead, updated_at=now()
    `,
    [clientId, from, JSON.stringify(leadObj)]
  );
}

export async function resetSession(clientId, from) {
  await pool.query("delete from sessions where client_id=$1 and wa_from=$2", [
    clientId,
    from,
  ]);
}

export async function insertLead(clientId, from, { name, email, need }) {
  await pool.query(
    `
    insert into leads (client_id, wa_from, name, email, need)
    values ($1, $2, $3, $4, $5)
    `,
    [clientId, from, name || null, email || null, need || null]
  );
}