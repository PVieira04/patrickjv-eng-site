// Attached only to the alias hostnames (www.patrickjv.com, pvieira.co.uk, www.pvieira.co.uk).
// Every request redirects permanently to the primary domain, keeping path and query. The
// destination host is fixed, so no incoming value can choose where the redirect goes.
const PRIMARY = "https://patrickjv.com";

// Same baseline as the MCP Worker: a redirect has nothing to render, load or frame.
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // 301 lets clients turn a POST into a GET; 308 keeps the method and body, so use it for
    // everything but GET/HEAD (where 301 is the most widely understood).
    const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
    return new Response(null, { status, headers: { location: PRIMARY + url.pathname + url.search, ...SECURITY_HEADERS } });
  },
};
