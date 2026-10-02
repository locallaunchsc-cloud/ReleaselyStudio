// Releasely Studio: tiny API for the usage counter.
// Everything else (the site itself) is served straight from /public.

const EVENTS = new Set(["album", "teasers"]);
const AID = /^[a-f0-9]{8,48}$/;

async function ensureTables(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)"),
    // One row per anonymous browser ID and event: lets us count unique artists. No songs or personal info.
    db.prepare("CREATE TABLE IF NOT EXISTS artists (aid TEXT NOT NULL, event TEXT NOT NULL, first_seen TEXT NOT NULL DEFAULT (datetime('now')), n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (aid, event))"),
  ]);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/count" && request.method === "POST") {
      // Only count requests coming from the site itself.
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ ok: false }, 403);
      let body = {};
      try { body = await request.json(); } catch {}
      const event = body.event;
      if (!EVENTS.has(event)) return json({ ok: false }, 400);
      await ensureTables(env.DB);
      const stmts = [
        env.DB.prepare(
          "INSERT INTO counters (name, n) VALUES (?1, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1"
        ).bind(event),
      ];
      if (typeof body.aid === "string" && AID.test(body.aid)) {
        stmts.push(env.DB.prepare(
          "INSERT INTO artists (aid, event) VALUES (?1, ?2) ON CONFLICT(aid, event) DO UPDATE SET n = n + 1"
        ).bind(body.aid, event));
      }
      await env.DB.batch(stmts);
      return json({ ok: true });
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
      await ensureTables(env.DB);
      const [counts, uniq, repeat] = await env.DB.batch([
        env.DB.prepare("SELECT name, n FROM counters"),
        env.DB.prepare("SELECT COUNT(DISTINCT aid) AS artists FROM artists"),
        env.DB.prepare("SELECT COUNT(*) AS returning FROM (SELECT aid FROM artists GROUP BY aid HAVING SUM(n) > 1)"),
      ]);
      const out = { album: 0, teasers: 0 };
      for (const r of counts.results) if (EVENTS.has(r.name)) out[r.name] = r.n;
      // Unique artists only counted from this update onward; earlier albums had no ID.
      out.artists = uniq.results[0]?.artists || 0;
      out.returning = repeat.results[0]?.returning || 0;
      return json(out);
    }

    // Anything else that isn't a real file.
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};
