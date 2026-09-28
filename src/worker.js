// Releasely Studio: tiny API for the usage counter.
// Everything else (the site itself) is served straight from /public.

const EVENTS = new Set(["album", "teasers"]);

async function ensureTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)"
  ).run();
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
      let event = "";
      try { event = (await request.json()).event; } catch {}
      if (!EVENTS.has(event)) return json({ ok: false }, 400);
      await ensureTable(env.DB);
      await env.DB.prepare(
        "INSERT INTO counters (name, n) VALUES (?1, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1"
      ).bind(event).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
      await ensureTable(env.DB);
      const { results } = await env.DB.prepare("SELECT name, n FROM counters").all();
      const out = { album: 0, teasers: 0 };
      for (const r of results) if (EVENTS.has(r.name)) out[r.name] = r.n;
      return json(out);
    }

    // Anything else that isn't a real file.
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};
