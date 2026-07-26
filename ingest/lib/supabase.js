// supabase.js — upsert rows via PostgREST.
//
// Uses the service_role key, which bypasses row-level security. It is read from
// the environment and never logged, never written to disk, never committed. In
// CI it comes from the repo's encrypted Actions secret.

const DEFAULT_URL = "https://qzjvwxuwghegkfxmmseh.supabase.co";
const BATCH = 200;

function config() {
  const url = process.env.SUPABASE_URL || DEFAULT_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. In CI add it under " +
        "Settings > Secrets and variables > Actions. Locally, export it for one " +
        "command rather than putting it in a file."
    );
  }
  return { url: url.replace(/\/$/, ""), key };
}

/**
 * Upsert substance rows, keyed on `id`.
 * @param {object[]} rows
 * @param {Function} [log]
 * @returns {Promise<number>} rows written
 */
export async function upsertSubstances(rows, log = () => {}) {
  const { url, key } = config();
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await fetch(`${url}/rest/v1/substances`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // merge-duplicates makes this an UPSERT on the primary key, which is
        // what lets the whole job be re-run safely.
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase upsert failed (HTTP ${res.status}): ${body.slice(0, 400)}`);
    }
    written += chunk.length;
    log(`  upserted ${written}/${rows.length}`);
  }
  return written;
}

/** Ids currently in the table — used by --prune to find rows this run didn't produce. */
export async function listExistingIds() {
  const { url, key } = config();
  const ids = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${url}/rest/v1/substances?select=id`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${offset}-${offset + pageSize - 1}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase select failed (HTTP ${res.status})`);
    const page = await res.json();
    ids.push(...page.map((r) => r.id));
    if (page.length < pageSize) break;
  }
  return ids;
}

/** Delete rows by id (used only by --prune). */
export async function deleteSubstances(ids, log = () => {}) {
  if (!ids.length) return 0;
  const { url, key } = config();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const list = chunk.map((id) => `"${encodeURIComponent(id)}"`).join(",");
    const res = await fetch(`${url}/rest/v1/substances?id=in.(${list})`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
    });
    if (!res.ok) throw new Error(`Supabase delete failed (HTTP ${res.status})`);
    log(`  pruned ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
  }
  return ids.length;
}
