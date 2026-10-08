// Reads the OAuth client from the JSON Google Cloud lets you download, so the secret never has to be
// typed or pasted. Set GOOGLE_CLIENT_FILE to its path; prints the client ID only, never the secret.
import { readFileSync } from "node:fs";
export const REDIRECT = "http://localhost:8765/callback";
export function loadClient() {
  const file = process.env.GOOGLE_CLIENT_FILE;
  if (!file) throw new Error("Set GOOGLE_CLIENT_FILE to the downloaded client_secret_….json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  const c = json.web ?? json.installed;
  if (!c?.client_id || !c?.client_secret) throw new Error("No client_id/client_secret in that file");
  if (json.web && !(c.redirect_uris ?? []).includes(REDIRECT))
    throw new Error(`Add ${REDIRECT} to the client's authorised redirect URIs, then download the JSON again`);
  console.log(`Client: ${c.client_id} (${json.web ? "web" : "desktop"})`);
  return { id: c.client_id, secret: c.client_secret };
}
