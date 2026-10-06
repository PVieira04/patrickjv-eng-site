// Serves the static site and 301-redirects alias hostnames to the primary domain, keeping path and query.
const PRIMARY = "patrickjv.com";
const ALIASES = new Set(["www.patrickjv.com", "pvieira.co.uk", "www.pvieira.co.uk"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (ALIASES.has(url.hostname)) {
      url.protocol = "https:";
      url.hostname = PRIMARY;
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
