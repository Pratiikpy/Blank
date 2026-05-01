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

// Order matters: newest first. The blog index renders in this order.
export const POSTS: BlogPost[] = [wave3Shipped, whyNoToken];

export const POSTS_BY_SLUG: Record<string, BlogPost> = Object.fromEntries(
  POSTS.map((p) => [p.slug, p]),
);
