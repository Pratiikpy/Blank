import type { ReactNode } from "react";

export interface BlogPostMeta {
  slug: string;
  title: string;
  date: string;
  summary: string;
  author: string;
  category: "writeup" | "changelog" | "deep-dive" | "post-mortem";
  readingTimeMin: number;
}

export interface BlogPost extends BlogPostMeta {
  content: () => ReactNode;
}

import whyNoToken from "./why-no-token-ever";
import wave3Shipped from "./wave-3-shipped";
import fheVsZk from "./fhe-vs-zk";
import whyFhenixCofhe from "./why-fhenix-cofhe";

// Order matters: newest first. The blog index renders in this order.
// fhe-vs-zk and why-fhenix-cofhe share the 2026-05-01 date; the
// Fhenix-specific post sits first because it's the deeper partner-
// facing piece and we want it on top of the blog index.
export const POSTS: BlogPost[] = [whyFhenixCofhe, fheVsZk, wave3Shipped, whyNoToken];

export const POSTS_BY_SLUG: Record<string, BlogPost> = Object.fromEntries(
  POSTS.map((p) => [p.slug, p]),
);
