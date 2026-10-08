// Race spike for F-001: see README.md and run.sh. Not deployed; local `wrangler dev` only.
import { DurableObject } from "cloudflare:workers";
const google = () => new Promise((r) => setTimeout(r, 30)); // stands in for freebusy + events.insert
export class Store extends DurableObject {
  constructor(ctx, env) { super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS b (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT, slot TEXT, status TEXT)"); }
  reset() { this.ctx.storage.sql.exec("DELETE FROM b"); }
  // Naive: check, await Google, then write.
  async naive(slot) {
    const taken = this.ctx.storage.sql.exec("SELECT 1 FROM b WHERE mode='naive' AND slot=? AND status='confirmed'", slot).toArray().length;
    if (taken) return "lost";
    await google();
    this.ctx.storage.sql.exec("INSERT INTO b (mode, slot, status) VALUES ('naive', ?, 'confirmed')", slot);
    return "won";
  }
  // Safe: claim the slot synchronously (no await between check and write), then call Google,
  // then settle or roll back.
  async safe(slot) {
    const taken = this.ctx.storage.sql.exec("SELECT 1 FROM b WHERE mode='safe' AND slot=? AND status IN ('confirming','confirmed')", slot).toArray().length;
    if (taken) return "lost";
    const id = this.ctx.storage.sql.exec("INSERT INTO b (mode, slot, status) VALUES ('safe', ?, 'confirming') RETURNING id", slot).one().id;
    await google();
    this.ctx.storage.sql.exec("UPDATE b SET status='confirmed' WHERE id=?", id);
    return "won";
  }
  count(mode) { return this.ctx.storage.sql.exec("SELECT count(*) n FROM b WHERE mode=? AND status='confirmed'", mode).one().n; }
}
export default { async fetch(req, env) {
  const u = new URL(req.url); const s = env.STORE.get(env.STORE.idFromName("one"));
  const mode = u.searchParams.get("mode");
  if (u.pathname === "/reset") { await s.reset(); return new Response("ok"); }
  if (u.pathname === "/count") return new Response(String(await s.count(mode)));
  return new Response(await s[mode](u.searchParams.get("slot")));
} };
