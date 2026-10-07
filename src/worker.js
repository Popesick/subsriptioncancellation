import { DurableObject } from "cloudflare:workers";

// Reihenfolge der Bildschirme nach dem Login. Der Server akzeptiert nur den jeweils nächsten Schritt.
const STEPS = [
  "captcha", "confirm1", "confirm2", "upsell", "trap", "queue",
  "data", "hold", "final", "error", "done",
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const teamKey = (name) => name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function cleanTeamName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= 40 ? name : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    return env.BONUS.get(env.BONUS.idFromName("main")).fetch(request);
  },
};

export class BonusDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        team_key TEXT NOT NULL,
        team TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        step_at INTEGER NOT NULL,
        finished_at INTEGER,
        aborted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS runs_team ON runs(team_key);
      CREATE TABLE IF NOT EXISTS awards (team_key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_fails (at INTEGER NOT NULL);
    `);
  }

  isOpen() {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'open'").toArray()[0];
    return !row || row.value === "1";
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/status" && request.method === "GET") return json({ open: this.isOpen() });
      if (path.startsWith("/api/admin/")) return await this.admin(request, path);
      if (request.method !== "POST") return json({ error: "method" }, 405);
      const body = await request.json().catch(() => ({}));
      if (path === "/api/start") return this.start(body);
      if (path === "/api/step") return this.step(body);
      if (path === "/api/abort") return this.abort(body);
      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "server", detail: String(err?.message ?? err) }, 500);
    }
  }

  // ---------- Teams ----------

  start(body) {
    if (!this.isOpen()) return json({ error: "closed" }, 403);
    const team = cleanTeamName(body.team);
    if (!team) return json({ error: "team" }, 400);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO runs (id, team_key, team, started_at, step, step_at) VALUES (?, ?, ?, ?, 0, ?)",
      id, teamKey(team), team, now, now,
    );
    return json({ run: id, team });
  }

  getRun(id) {
    if (typeof id !== "string") return null;
    return this.sql.exec("SELECT * FROM runs WHERE id = ?", id).toArray()[0] ?? null;
  }

  step(body) {
    if (!this.isOpen()) return json({ error: "closed" }, 403);
    const run = this.getRun(body.run);
    if (!run) return json({ error: "unknown_run" }, 404);
    const idx = STEPS.indexOf(body.step);
    if (idx < 0) return json({ error: "step" }, 400);

    if (idx > run.step + 1) return json({ error: "skipped", have: run.step }, 409);
    if (idx === run.step + 1) {
      const now = Date.now();
      const finishing = STEPS[idx] === "done";
      this.sql.exec(
        "UPDATE runs SET step = ?, step_at = ?, finished_at = ?, aborted = 0 WHERE id = ?",
        idx, now, finishing ? now : null, run.id,
      );
      run.step = idx;
      run.step_at = now;
      if (finishing) run.finished_at = now;
    }

    const out = { ok: true, step: run.step };
    if (run.finished_at) {
      const team = this.sql
        .exec("SELECT MIN(finished_at) AS first FROM runs WHERE team_key = ? AND finished_at IS NOT NULL", run.team_key)
        .toArray()[0];
      const ahead = this.sql
        .exec(
          `SELECT COUNT(*) AS n FROM (
             SELECT team_key, MIN(finished_at) AS f FROM runs WHERE finished_at IS NOT NULL GROUP BY team_key
           ) WHERE f < ?`,
          team.first,
        )
        .toArray()[0];
      out.finished_at = run.finished_at;
      out.duration_ms = run.finished_at - run.started_at;
      out.rank = ahead.n + 1;
    }
    return json(out);
  }

  abort(body) {
    const run = this.getRun(body.run);
    if (run && !run.finished_at) this.sql.exec("UPDATE runs SET aborted = 1 WHERE id = ?", run.id);
    return json({ ok: true });
  }

  // ---------- Admin ----------

  async authorized(request) {
    const secret = this.env.ADMIN_PASSWORD;
    if (!secret) return "disabled";
    const since = Date.now() - 10 * 60 * 1000;
    this.sql.exec("DELETE FROM admin_fails WHERE at < ?", since);
    const fails = this.sql.exec("SELECT COUNT(*) AS n FROM admin_fails").toArray()[0].n;
    if (fails >= 10) return "locked";

    const header = request.headers.get("Authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
      crypto.subtle.digest("SHA-256", enc.encode(given)),
      crypto.subtle.digest("SHA-256", enc.encode(secret)),
    ]);
    if (crypto.subtle.timingSafeEqual(a, b)) return "ok";
    this.sql.exec("INSERT INTO admin_fails (at) VALUES (?)", Date.now());
    return "denied";
  }

  async admin(request, path) {
    const auth = await this.authorized(request);
    if (auth === "disabled") return json({ error: "admin_disabled" }, 503);
    if (auth === "locked") return json({ error: "locked" }, 429);
    if (auth !== "ok") return json({ error: "unauthorized" }, 401);

    if (path === "/api/admin/overview" && request.method === "GET") return json(this.overview());
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const body = await request.json().catch(() => ({}));

    if (path === "/api/admin/open") {
      this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('open', ?)", body.open ? "1" : "0");
    } else if (path === "/api/admin/award") {
      if (typeof body.team_key !== "string") return json({ error: "team_key" }, 400);
      if (body.awarded) {
        this.sql.exec("INSERT OR REPLACE INTO awards (team_key, at) VALUES (?, ?)", body.team_key, Date.now());
      } else {
        this.sql.exec("DELETE FROM awards WHERE team_key = ?", body.team_key);
      }
    } else if (path === "/api/admin/delete") {
      if (typeof body.team_key !== "string") return json({ error: "team_key" }, 400);
      this.sql.exec("DELETE FROM runs WHERE team_key = ?", body.team_key);
      this.sql.exec("DELETE FROM awards WHERE team_key = ?", body.team_key);
    } else if (path === "/api/admin/reset") {
      this.sql.exec("DELETE FROM runs");
      this.sql.exec("DELETE FROM awards");
    } else {
      return json({ error: "not_found" }, 404);
    }
    return json(this.overview());
  }

  overview() {
    const runs = this.sql.exec("SELECT * FROM runs ORDER BY started_at").toArray();
    const awards = new Set(this.sql.exec("SELECT team_key FROM awards").toArray().map((r) => r.team_key));
    const teams = new Map();
    for (const r of runs) {
      let t = teams.get(r.team_key);
      if (!t) {
        t = {
          team_key: r.team_key, team: r.team, attempts: 0, best_step: 0, finished_at: null,
          duration_ms: null, first_started_at: r.started_at, last_activity: 0, active: false,
          awarded: awards.has(r.team_key),
        };
        teams.set(r.team_key, t);
      }
      t.attempts++;
      t.team = r.team;
      t.best_step = Math.max(t.best_step, r.step);
      t.last_activity = Math.max(t.last_activity, r.step_at);
      if (r.finished_at && (t.finished_at === null || r.finished_at < t.finished_at)) {
        t.finished_at = r.finished_at;
        t.duration_ms = r.finished_at - r.started_at;
      }
    }
    const latest = new Map();
    for (const r of runs) latest.set(r.team_key, r);
    for (const [key, t] of teams) {
      const r = latest.get(key);
      t.active = !r.aborted && !r.finished_at;
      t.current_step = r.step;
    }
    const list = [...teams.values()].sort((a, b) => {
      if (a.finished_at && b.finished_at) return a.finished_at - b.finished_at;
      if (a.finished_at) return -1;
      if (b.finished_at) return 1;
      return b.best_step - a.best_step || b.last_activity - a.last_activity;
    });
    return { open: this.isOpen(), steps: STEPS, now: Date.now(), teams: list };
  }
}
