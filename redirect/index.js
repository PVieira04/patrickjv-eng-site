// Attached only to the alias hostnames (www.patrickjv.com, pvieira.co.uk, www.pvieira.co.uk).
// Every request 301s to the primary domain, keeping path and query. The destination host is
// fixed, so no incoming value can choose where the redirect goes.
const PRIMARY = "https://patrickjv.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(PRIMARY + url.pathname + url.search, 301);
  },
};
