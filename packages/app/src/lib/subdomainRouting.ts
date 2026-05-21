const SUBDOMAIN_TARGETS: Record<string, string> = {
  "app.myblank.app": "/app",
  "brand.myblank.app": "/brand-kit",
  "blog.myblank.app": "/blog",
  "docs.myblank.app": "/whitepaper",
};

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/:\d+$/, "");
}

function hasFileExtension(pathname: string) {
  return /\.[a-z0-9]{2,8}$/i.test(pathname);
}

export function getSubdomainRouteTarget(hostname: string, pathname: string) {
  const host = normalizeHostname(hostname);
  const target = SUBDOMAIN_TARGETS[host];
  if (!target || hasFileExtension(pathname)) return null;

  if (host === "app.myblank.app") {
    if (pathname === "/") return "/app";
    if (pathname === "/app" || pathname.startsWith("/app/")) return null;
    return `/app${pathname}`;
  }

  if (host === "blog.myblank.app") {
    if (pathname === "/") return "/blog";
    if (pathname === "/blog" || pathname.startsWith("/blog/")) return null;
    return `/blog${pathname}`;
  }

  if (pathname === target || pathname.startsWith(`${target}/`)) return null;
  if (pathname === "/") return target;

  return null;
}
