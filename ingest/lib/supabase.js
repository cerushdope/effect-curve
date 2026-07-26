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
 * Prove we can actually WRITE, before spending two minutes downloading.
 *
 * Checking that the key is merely *present* is not enough — that check passes
 * happily while the grants are missing, and you only find out at the upsert.
 * So round-trip a sentinel row: insert it, delete it. Runs in ~200 ms.
 */
export async function preflight(log = () => {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const probe = {
    id: "__ingest_preflight__",
    name: "preflight probe",
    category: "internal",
    aliases: [],
    unit: "mg",
    confidence: "low",
    record: { preflight: true },
  };

  const res = await fetch(`${url}/rest/v1/substances`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([probe]),
  });

  if (!res.ok) {
    const body = await res.text();
    let hint = "";
    if (res.status === 403 || body.includes("42501")) {
      hint =
        "\n  The key is valid but the role lacks table privileges. service_role\n" +
        "  bypasses row-level security but still needs GRANTs. In the Supabase\n" +
        "  SQL editor run:\n\n" +
        "    grant select, insert, update, delete on table public.substances to service_role;\n";
    } else if (res.status === 401) {
      hint =
        "\n  The key was rejected. Check you used the SECRET key (sb_secret_… or the\n" +
        "  legacy service_role JWT), not the publishable one — they sit next to each\n" +
        "  other in Settings > API Keys, and the publishable key cannot write.\n";
    }
    throw new Error(`Supabase preflight write failed (HTTP ${res.status}): ${body.slice(0, 300)}${hint}`);
  }

  // Clean up. A leftover probe row is cosmetic, so warn rather than fail.
  const del = await fetch(`${url}/rest/v1/substances?id=eq.__ingest_preflight__`, {
    method: "DELETE",
    headers: { ...headers, Prefer: "return=minimal" },
  });
  if (!del.ok) log("  preflight: probe row could not be deleted — remove __ingest_preflight__ by hand");
  log("  preflight: write access confirmed");
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
