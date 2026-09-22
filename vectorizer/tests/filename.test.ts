import { describe, it, expect } from "vitest";
import { patternFileStem, patternNameFromFile } from "../src/lib/filename";

describe("patternFileStem", () => {
  it("keeps an ordinary name as typed", () => {
    expect(patternFileStem("Rose window")).toBe("Rose window");
  });

  it("replaces characters a filesystem would reject", () => {
    expect(patternFileStem('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
  });

  it("collapses the whitespace stripping leaves behind", () => {
    expect(patternFileStem("panel///one")).toBe("panel one");
    expect(patternFileStem("  spaced   out  ")).toBe("spaced out");
  });

  it("strips leading and trailing dots", () => {
    // A leading dot hides the file on Unix; Windows drops trailing dots.
    expect(patternFileStem(".hidden")).toBe("hidden");
    expect(patternFileStem("trailing...")).toBe("trailing");
    expect(patternFileStem("keeps.inner.dots")).toBe("keeps.inner.dots");
  });

  it("falls back to 'pattern' rather than emitting a bare extension", () => {
    expect(patternFileStem("")).toBe("pattern");
    expect(patternFileStem("   ")).toBe("pattern");
    expect(patternFileStem("///")).toBe("pattern");
    expect(patternFileStem("...")).toBe("pattern");
  });

  it("drops control characters a paste can carry in", () => {
    expect(patternFileStem("tab\there")).toBe("tab here");
    expect(patternFileStem("null\u0000byte")).toBe("null byte");
  });

  it("caps the length, and does not leave a trailing space when it cuts", () => {
    const long = patternFileStem("x".repeat(400));
    expect(long.length).toBe(120);
    const cutAtSpace = patternFileStem(`${"x".repeat(119)} tail`);
    expect(cutAtSpace.endsWith(" ")).toBe(false);
  });

  it("keeps unicode names intact", () => {
    expect(patternFileStem("café — naïve")).toBe("café — naïve");
  });
});

describe("patternNameFromFile", () => {
  it("drops the extension", () => {
    expect(patternNameFromFile("roses.png")).toBe("roses");
    expect(patternNameFromFile("scan.JPEG")).toBe("scan");
  });

  it("drops only the final extension", () => {
    expect(patternNameFromFile("rose.window.png")).toBe("rose.window");
  });

  it("leaves a name with no extension alone", () => {
    expect(patternNameFromFile("untitled")).toBe("untitled");
  });

  it("does not mistake a dot in a directory name for an extension", () => {
    expect(patternNameFromFile("my.patterns/rose")).toBe("my.patterns/rose");
  });
});
