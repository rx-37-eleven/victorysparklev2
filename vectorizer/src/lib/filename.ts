// Turning the pattern's name into a filename for the exported SVG and PNG.
//
// Kept apart from the component so the rules are testable: this is the sort
// of thing that quietly produces a file the operating system refuses to save,
// or -- worse -- one it saves under a name the artist did not expect.

/** Characters Windows rejects outright in a filename; the slash also breaks paths on Unix. */
const ILLEGAL = /[/\\:*?"<>|]/g;

/**
 * Control characters. Typing cannot produce these, but a paste from a
 * spreadsheet or a PDF can, and they survive all the way into the download
 * attribute.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Longest stem we will emit, leaving room for an extension well inside the usual 255-byte limit. */
const MAX_LENGTH = 120;

/**
 * The filename stem for a pattern called `name`, without an extension.
 *
 * Falls back to "pattern" when the name is empty or consists only of
 * characters that had to be stripped, so an export always produces a usable
 * file rather than one called ".svg".
 */
export function patternFileStem(name: string): string {
  const cleaned = name
    .replace(ILLEGAL, " ")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot hides the file on Unix; Windows silently drops trailing dots.
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, MAX_LENGTH)
    .trim();
  return cleaned || "pattern";
}

/**
 * A pattern name seeded from the dropped file: its own name without the
 * extension. Only the final extension is removed, so "rose.window.png"
 * becomes "rose.window" rather than "rose".
 */
export function patternNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "");
}
