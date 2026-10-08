// One-off: authorise hello@patrickjv.com and print a refresh token.
// Usage: GOOGLE_CLIENT_FILE=<downloaded client_secret_….json> node get-token.mjs
// The OAuth client (type "Web application") must list http://localhost:8765/callback as a redirect URI.
import http from "node:http";
import { loadClient, REDIRECT as redirect } from "./client.mjs";
const { id, secret } = loadClient();
const scopes = ["https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.events.owned"];
const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: "code", scope: scopes.join(" "),
  access_type: "offline", prompt: "consent", login_hint: "hello@patrickjv.com" });
console.log("Open this in a browser and sign in as hello@patrickjv.com:\n\n" + url + "\n");
http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get("code");
  if (!code) { res.end("No code"); return; }
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
    code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }) });
  const j = await r.json();
  res.end(j.refresh_token ? "Done. Close this tab." : "Failed, see terminal.");
  console.log(j.refresh_token ? `Granted scopes: ${j.scope}\n\nRefresh token (keep secret):\n${j.refresh_token}` : j);
  process.exit(0);
}).listen(8765);
