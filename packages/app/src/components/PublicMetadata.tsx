import { useEffect } from "react";
import { useLocation } from "react-router-dom";

interface PageMetadata {
  title: string;
  description: string;
  canonical: string;
}

const SITE = "https://www.myblank.app";
const APP = "https://app.myblank.app";
const DOCS = "https://docs.myblank.app";
const BRAND = "https://brand.myblank.app";
const BLOG = "https://blog.myblank.app";

function metadataForPath(pathname: string): PageMetadata {
  if (pathname === "/whitepaper") {
    return {
      title: "Blank Whitepaper | Private Amount Payments",
      description: "Blank's privacy model, CoFHE architecture, product surface and testnet security boundary.",
      canonical: `${DOCS}/whitepaper`,
    };
  }
  if (pathname === "/brand-kit") {
    return {
      title: "Blank Brand Kit",
      description: "The identity system and public brand assets for Blank.",
      canonical: `${BRAND}/brand-kit`,
    };
  }
  if (pathname === "/blog" || pathname.startsWith("/blog/")) {
    const postMetadata: Record<string, PageMetadata> = {
      "/blog/why-fhenix-cofhe": {
        title: "Why Blank Chose Fhenix CoFHE Over FHE L1s | Blank",
        description: "Why Blank uses the Fhenix CoFHE co-processor model for private amount payments on Ethereum.",
        canonical: `${BLOG}/blog/why-fhenix-cofhe`,
      },
      "/blog/fhe-vs-zk": {
        title: "FHE And Zero-Knowledge For Private Payments | Blank",
        description: "Why computation on encrypted payment values requires a different primitive from proving statements.",
        canonical: `${BLOG}/blog/fhe-vs-zk`,
      },
      "/blog/wave-3-shipped": {
        title: "Wave 3 Shipped | Blank",
        description: "Workspace modes, private invoice escrow and proof-of-payment features shipped on Blank testnet.",
        canonical: `${BLOG}/blog/wave-3-shipped`,
      },
      "/blog/why-no-token-ever": {
        title: "Why Blank Has No Token | Blank",
        description: "Why Blank is building private payment infrastructure without issuing a token.",
        canonical: `${BLOG}/blog/why-no-token-ever`,
      },
    };
    if (postMetadata[pathname]) return postMetadata[pathname];
    return {
      title: "Blank Blog | Private Payments and FHE",
      description: "Technical writing and product decisions behind confidential payments built with Fhenix CoFHE.",
      canonical: `${BLOG}/blog`,
    };
  }
  if (pathname === "/status") {
    return {
      title: "Blank Status | Testnet Health",
      description: "Live health for Blank on Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia.",
      canonical: `${SITE}/status`,
    };
  }
  if (pathname === "/features") {
    return {
      title: "Features | Blank",
      description: "Private payment, commerce, proof and exchange surfaces on Blank testnet.",
      canonical: `${SITE}/features`,
    };
  }
  if (pathname === "/roadmap") {
    return {
      title: "Roadmap | Blank",
      description: "What Blank has shipped on testnet and what remains gated before mainnet.",
      canonical: `${SITE}/roadmap`,
    };
  }
  if (pathname === "/live") {
    return {
      title: "Live Activity | Blank",
      description: "Public testnet activity for Blank with encrypted payment amounts and explorer-linked settlement.",
      canonical: `${SITE}/live`,
    };
  }
  if (pathname === "/manifesto") {
    return {
      title: "Manifesto | Blank",
      description: "Why public settlement should not require permanently public payment amounts.",
      canonical: `${SITE}/manifesto`,
    };
  }
  if (pathname === "/pricing") {
    return {
      title: "Pricing | Blank",
      description: "Testnet access and intended pricing direction for private amount payments on Blank.",
      canonical: `${SITE}/pricing`,
    };
  }
  const audienceMetadata: Record<string, PageMetadata> = {
    "/for/individuals": {
      title: "Blank For Individuals | Private Payments",
      description: "Private amount payments for everyday transfers and shared expenses.",
      canonical: `${SITE}/for/individuals`,
    },
    "/for/creators": {
      title: "Blank For Creators | Private Payments",
      description: "Private tips, storefront payments and supporter flows for creators.",
      canonical: `${SITE}/for/creators`,
    },
    "/for/businesses": {
      title: "Blank For Businesses | Private Payments",
      description: "Private invoice, payroll and vendor payment workflows for businesses.",
      canonical: `${SITE}/for/businesses`,
    },
    "/for/daos": {
      title: "Blank For DAOs | Private Payments",
      description: "Private contributor payments and treasury workflows for on-chain organizations.",
      canonical: `${SITE}/for/daos`,
    },
  };
  if (audienceMetadata[pathname]) return audienceMetadata[pathname];
  if (pathname === "/how-it-works") {
    return {
      title: "How Blank Works | Fhenix CoFHE Payments",
      description: "How Blank keeps payment amounts encrypted while transactions settle on public chains.",
      canonical: `${SITE}/how-it-works`,
    };
  }
  if (pathname.startsWith("/app")) {
    const suffix = pathname === "/app" ? "" : pathname.slice(4);
    return {
      title: "Blank App | Private Amount Payments",
      description: "Use Blank on supported testnets to send payments with encrypted amounts.",
      canonical: `${APP}${suffix}`,
    };
  }

  return {
    title: "Blank | Private Amount Payments",
    description: "Private amount payments on Ethereum testnets, built with Fhenix CoFHE.",
    canonical: `${SITE}${pathname === "/" ? "" : pathname}`,
  };
}

function setMeta(selector: string, key: "name" | "property", value: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(key, value);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

export function PublicMetadata() {
  const { pathname } = useLocation();

  useEffect(() => {
    const meta = metadataForPath(pathname);
    document.title = meta.title;

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = meta.canonical;

    setMeta('meta[name="description"]', "name", "description", meta.description);
    setMeta('meta[property="og:title"]', "property", "og:title", meta.title);
    setMeta('meta[property="og:description"]', "property", "og:description", meta.description);
    setMeta('meta[property="og:url"]', "property", "og:url", meta.canonical);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", meta.title);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", meta.description);
  }, [pathname]);

  return null;
}
