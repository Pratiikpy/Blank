export const PUBLIC_LINKS = {
  site: "https://www.myblank.app",
  app: "https://app.myblank.app",
  docs: "https://docs.myblank.app",
  brand: "https://brand.myblank.app",
  blog: "https://blog.myblank.app",
} as const;

export function canonicalPublicHref(path: string) {
  if (path === "/app") return PUBLIC_LINKS.app;
  if (path.startsWith("/app/")) return `${PUBLIC_LINKS.app}${path.slice(4)}`;
  if (path === "/") return PUBLIC_LINKS.site;
  return `${PUBLIC_LINKS.site}${path}`;
}
