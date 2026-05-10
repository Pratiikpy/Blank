import { describe, it, expect } from "vitest";
import {
  findThemeById,
  parseThemeFromDescription,
  DEFAULT_THEME,
  GIFT_THEMES,
} from "./gift-themes";

// §15.x lib test for the gift-theme registry. Both helpers must
// always return SOMETHING — defaulting to the neutral "Thank You"
// theme when input is missing or unrecognized — so callers can
// render a card without null checks.

describe("findThemeById", () => {
  it("returns DEFAULT_THEME for null / undefined / unknown id", () => {
    expect(findThemeById(null)).toBe(DEFAULT_THEME);
    expect(findThemeById(undefined)).toBe(DEFAULT_THEME);
    expect(findThemeById(9999)).toBe(DEFAULT_THEME);
  });

  it("returns the matching theme for a known id", () => {
    for (const tpl of GIFT_THEMES) {
      expect(findThemeById(tpl.id)).toBe(tpl);
    }
  });
});

describe("parseThemeFromDescription", () => {
  it("returns DEFAULT_THEME for null / empty", () => {
    expect(parseThemeFromDescription(null)).toBe(DEFAULT_THEME);
    expect(parseThemeFromDescription(undefined)).toBe(DEFAULT_THEME);
    expect(parseThemeFromDescription("")).toBe(DEFAULT_THEME);
  });

  it("matches a 'Theme: msg' prefix case-insensitively", () => {
    expect(parseThemeFromDescription("Birthday: happy day").name).toBe("Birthday");
    expect(parseThemeFromDescription("birthday: happy day").name).toBe("Birthday");
  });

  it("strips the envelope-id prefix before matching the theme", () => {
    // History-row format wraps the description as "[envelope:42] Birthday: ..."
    expect(parseThemeFromDescription("[envelope:42] Birthday: hi").name).toBe(
      "Birthday",
    );
  });

  it("falls back to DEFAULT_THEME when the prefix has no colon", () => {
    expect(parseThemeFromDescription("just a plain message")).toBe(DEFAULT_THEME);
  });

  it("falls back to DEFAULT_THEME when prefix matches no theme name", () => {
    expect(parseThemeFromDescription("Festivus: gripes incoming")).toBe(
      DEFAULT_THEME,
    );
  });

  it("recovers the theme even when the message body has additional colons", () => {
    expect(
      parseThemeFromDescription("Celebration: scope: includes everything").name,
    ).toBe("Celebration");
  });
});
