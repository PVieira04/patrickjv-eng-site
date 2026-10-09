// A local server for driving the built /book page in a real browser (F-003): serves public/book.html
// with its production headers (including the CSP) from public/_headers, the self-hosted fonts and
// favicon, and a fake same-origin booking API. Not a test file itself (the glob is *.test.mjs).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));

// The header lines of the _headers rule for exactly `path`.
export function headersFor(path) {
  const block = readFileSync(join(PUBLIC, "_headers"), "utf8").split("\n\n").map((b) => b.replace(/^(#.*\n)+/, "")).find((b) => b.split("\n")[0] === path);
  return Object.fromEntries(block.split("\n").slice(1).map((l) => l.trim().match(/^([^:]+):\s*(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v]));
}

export const TYPES = { enabled: true, types: [
  { id: "consultation", title: "Consultation", minutes: 30, description: "A 30-minute call about a platform, infrastructure or AI agent problem you're working on." },
  { id: "recruiter-intro", title: "Recruiter intro", minutes: 15, description: "A 15-minute call for recruiters to introduce a role." },
] };

// Weekday slots every 15 minutes from 10:00 to 16:30 London time, as the real config gives, over
// the given London days (YYYY-MM-DD, all in GMT here), minus a few taken times so days differ.
export function fakeSlots(days, minutes = 30) {
  const slots = [];
  days.forEach((d, i) => {
    for (let m = 10 * 60; m + minutes <= 17 * 60; m += 15) {
      if ((m / 15 + i) % 5 === 0) continue;
      const start = new Date(`${d}T00:00:00Z`).getTime() + m * 6e4;
      slots.push({ start: new Date(start).toISOString().replace(".000Z", "+00:00"), end: new Date(start + minutes * 6e4).toISOString().replace(".000Z", "+00:00") });
    }
  });
  return { timezone: "Europe/London", slots };
}

const TYPE = { ".woff2": "font/woff2", ".svg": "image/svg+xml" };

// Starts the server on a free port. `availability(type)` returns the availability body; every
// POST body is recorded in `posts`. Resolves to { url, posts, close }.
export function startBookServer({ availability = () => fakeSlots(["2026-10-26", "2026-10-27", "2026-10-29", "2026-11-02", "2026-11-04", "2026-11-05", "2026-11-09", "2026-11-10", "2026-11-12", "2026-11-16", "2026-11-18", "2026-11-19"]) } = {}) {
  const posts = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/book") {
      res.writeHead(200, { ...headersFor("/book"), "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(PUBLIC, "book.html")));
    }
    if (url.pathname === "/api/booking/types") return json(200, TYPES);
    if (url.pathname === "/api/booking/availability") return json(200, availability(url.searchParams.get("type")));
    if (url.pathname === "/api/booking" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { posts.push(JSON.parse(body)); json(202, { booking_id: "a".repeat(32), status: "pending_confirmation", hold_expires: "2026-10-20T12:00:00+00:00" }); });
      return;
    }
    if (/^\/(fonts\/[\w.-]+\.woff2|favicon\.svg)$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": TYPE[url.pathname.slice(url.pathname.lastIndexOf("."))] });
      return res.end(readFileSync(join(PUBLIC, url.pathname)));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise((r) => server.close(r)) })));
}
