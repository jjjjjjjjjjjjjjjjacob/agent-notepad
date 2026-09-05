export function workosDiscovery() {
  const domain = process.env.WORKOS_AUTHKIT_DOMAIN;
  if (!domain) return null;
  const url = new URL(domain);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("WORKOS_AUTHKIT_DOMAIN must be an HTTPS origin.");
  return { origin: url.origin, authMdUrl: `${url.origin}/agent/auth.md` };
}
