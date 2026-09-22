import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The app's page shell carries its own copy of the main site's header, because
 * it is a Vite-built SPA rather than an Eleventy template and cannot include
 * base.njk's partial. A copy drifts: the Watermarker entry was added to the
 * site nav and to all four sibling app pages but not to this one, and the
 * Miniver webfont that `.site-title` depends on was never linked here at all,
 * so the site title rendered in the browser's generic cursive on this page and
 * in Miniver everywhere else.
 *
 * These tests are the thing that was missing -- nothing enforced the parity the
 * shell's comment claimed.
 */

const repoRoot = resolve(__dirname, "..", "..");
const base = readFileSync(resolve(repoRoot, "src/_includes/base.njk"), "utf8");
const shell = readFileSync(resolve(repoRoot, "vectorizer/index.html"), "utf8");

function headerMarkup(html: string): string {
  const match = html.match(/<header\b[\s\S]*?<\/header>/);
  if (!match) throw new Error("no <header> found");
  return match[0]
    .replace(/\s+/g, " ")
    .replace(/\s*\/>/g, ">") // base.njk writes <img ...>, the shell <img ... />
    .replace(/>\s+</g, "><")
    .trim();
}

/** The font families a page asks Google Fonts for, lowercased and sorted. */
function fontFamilies(html: string): string[] {
  const link = html.match(/https:\/\/fonts\.googleapis\.com\/css2\?([^"']+)/);
  if (!link) throw new Error("no Google Fonts link found");
  return [...link[1].matchAll(/family=([^&:]+)/g)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, " ").toLowerCase()).sort();
}

describe("app shell header matches the main site", () => {
  it("uses identical header markup to base.njk", () => {
    expect(headerMarkup(shell)).toBe(headerMarkup(base));
  });

  it("loads every font family the site header's styling depends on", () => {
    const siteFonts = fontFamilies(base);
    const shellFonts = fontFamilies(shell);
    for (const family of siteFonts) expect(shellFonts).toContain(family);
  });

  it("loads Miniver, which .site-title resolves to via --font-script", () => {
    const tokens = readFileSync(resolve(repoRoot, "src/css/tokens.css"), "utf8");
    const script = tokens.match(/--font-script:\s*([^;]+);/);
    expect(script).not.toBeNull();
    const primary = script![1].split(",")[0].replace(/["']/g, "").trim().toLowerCase();
    expect(fontFamilies(shell)).toContain(primary);
  });

  it("offers the same set of nav destinations as the site header", () => {
    const links = (html: string) =>
      [...headerMarkup(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(links(shell)).toEqual(links(base));
  });
});
