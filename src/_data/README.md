# src/_data

This folder holds the "content" that feeds the site's pages. You generally
don't need to touch anything else in the repo to make simple updates —
these files ARE the editing interface for the pages that use them.

## How to update the travel map

The map at victorysparkle.com/map/ is colored entirely from one file:
`travelmap.json`. You never need to touch any code, and you don't have to
list all 50 states — any state you don't mention just uses the default
color ("Not yet").

**To change a state's color (e.g. mark a trip you just took):**

1. Go to `src/_data/travelmap.json` on GitHub.
2. Click the pencil icon (top right of the file) to edit it.
3. Find the `"states"` section. Add a line like:
   ```
   "TX": "visited",
   ```
   The left side is the state's two-letter postal code (TX, CA, NY, etc).
   The right side must exactly match one of the category names defined
   up in the `"legend"` section above it (by default: `visited`, `lived`,
   `planned`, or `none`).
4. Scroll down and click "Commit changes."
5. Cloudflare Pages will automatically rebuild the site — give it about a
   minute, then refresh victorysparkle.com/map/ and your change will be live.

**To add, rename, or recolor a whole category** (say you want a new
"Want to visit" category), edit the `"legend"` object at the top of the
same file — add a new entry with a label and a hex color, then use that
same key in the `"states"` section. The legend on the page updates itself
automatically, including the count of states in each category.

**A couple of things to know:**
- If you accidentally type a status that isn't defined in the legend
  (a typo, for example), that state will just fall back to the default
  "Not yet" color instead of breaking the site.
- Washington D.C. is supported too — use `"DC"`.
- The three states already in the file (PA, NY, MD) are just examples —
  feel free to delete them and start fresh, or keep them if they're accurate!

## How to add a resource to the Cool Web Resources page

Same idea, different file: `src/_data/resources.json`. See the comment
at the top of `src/resources.njk` for the short version, or just copy the
shape of the existing entry and fill in your own title/url/date/tags.
