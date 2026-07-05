// Pass-through proxy: api.agee.app -> chief-moa VPS gateway.
// Exists because the wrangler OAuth token cannot create DNS records directly;
// a Workers custom domain creates the record and edge cert for us. Replace
// with a plain proxied A record once a Zone:DNS:Edit token is available.
const ORIGIN_HOST = "chief-moa.143.198.226.83.sslip.io";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = ORIGIN_HOST;
    url.protocol = "https:";
    url.port = "";
    return fetch(new Request(url, request));
  },
};
