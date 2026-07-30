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

**To add the year you were there (shown when you hover/tap the state):**

Instead of a plain status string, use an object with `"status"` and `"year"`:

```
"TX": { "status": "lived", "year": "2011–2015" },
"NY": { "status": "visited", "year": "2019" },
```

The `"year"` value is free-form text, not just a single year — `"2018, 2022"`
works too. If you leave `"year"` off (or just use the plain
`"TX": "lived"` form), the hover tooltip shows the state name only, with
no status label. Both forms — plain string or `{ status, year }` object —
work everywhere `travelmap.json` is used, so you don't need to convert
your existing entries.

**A couple of things to know:**
- If you accidentally type a status that isn't defined in the legend
  (a typo, for example), that state will just fall back to the default
  "Not yet" color instead of breaking the site.
- Washington D.C. is supported too — use `"DC"`.

## How to mark a country

Below the US map, `/map/` also has regional maps (Eastern Europe, Western
Europe, Asia, South America). They work exactly like the states map, just
in one shared `"countries"` section of the same `travelmap.json` file
instead of `"states"`:

```
"countries": {
  "PL": { "status": "visited", "year": "2023" },
  "JP": "planned"
}
```

- The left side is the country's two-letter code, not the state kind —
  these are [ISO 3166-1 alpha-2 codes](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2)
  (PL for Poland, JP for Japan, and so on — the Wikipedia page has the
  full list).
- The right side works exactly like states: either a plain status key
  (`"visited"`) or an object with `"status"` and an optional `"year"`.
- Any country not listed defaults to "Not yet," same as states.
- The same `"legend"` categories and colors apply to both states and
  countries — there's only one legend to edit.
- You only need to list a country once, in `"countries"` — you don't pick
  which regional map it shows up on, that's already decided by which
  region the country belongs to.

**Changing which countries appear on a map (developer-only):** which
countries are drawn on each regional map, and the map's geography itself,
comes from `tools/regions.js` and is generated into
`src/_data/regionMaps.json` by a build script — not something you edit
through the GitHub web UI. Editing `tools/regions.js` requires running
`npm run maps` locally afterward to regenerate `regionMaps.json`, then
committing both files. Marking countries visited/planned/etc. never
requires this — only adding/removing/re-drawing an entire country's shape
does.

## How to add a resource to the Cool Web Resources page

Same idea, different file: `src/_data/resources.json`. See the comment
at the top of `src/resources.njk` for the short version, or just copy the
shape of the existing entry and fill in your own title/url/date/tags.

## How to change the blog's display timezone

`src/_data/site.js`'s `blogTimezone` key controls what timezone blog post
timestamps are shown in (e.g. `America/New_York`, `America/Los_Angeles`).
Posts themselves are always stored in UTC — this only changes the `postDate`
filter's output. Edit the value, commit, and the next build picks it up.

## How to add an event to the "Where to Find Me" page

Same idea again: `src/_data/events.json` is a plain array you edit through the
GitHub web UI, no code changes needed.

1. Go to `src/_data/events.json` on GitHub and click the pencil icon.
2. Add an object to the array with at least:
   - `"name"` — the event's name.
   - `"startDate"` — `"YYYY-MM-DD"`.
   Optionally include `"endDate"` (for multi-day events), `"venue"`, `"city"`,
   `"url"`, `"booth"`, and `"note"`.
3. Commit — Cloudflare Pages rebuilds and the event shows up on `/events/`.

You don't need to sort the array or move things around yourself: events are
split into "Coming up" and "Previously" automatically based on today's date
at build time (an event stays in "Coming up" through the end of its
`endDate`, or its `startDate` if there's no `endDate`). Since that check only
runs when the site builds, an event moves to "Previously" on the next
Cloudflare Pages build after its date passes, not the instant the date
ticks over.
