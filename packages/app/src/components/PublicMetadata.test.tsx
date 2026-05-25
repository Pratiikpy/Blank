import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PublicMetadata } from "./PublicMetadata";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PublicMetadata />
    </MemoryRouter>,
  );
}

describe("PublicMetadata", () => {
  it("publishes route-specific status metadata", async () => {
    renderAt("/status");

    await waitFor(() => {
      expect(document.title).toBe("Blank Status | Testnet Health");
    });
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href"))
      .toBe("https://www.myblank.app/status");
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute("content"))
      .toBe("https://www.myblank.app/status");
  });

  it("publishes canonical branded document and application domains", async () => {
    const whitepaper = renderAt("/whitepaper");
    await waitFor(() => {
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href"))
        .toBe("https://docs.myblank.app/whitepaper");
    });
    whitepaper.unmount();

    renderAt("/app/send");
    await waitFor(() => {
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href"))
        .toBe("https://app.myblank.app/send");
    });
  });
});
