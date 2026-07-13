This folder holds screenshot images for the "Cool Web Resources" page
(victorysparkle.com/resources/).

HOW IT WORKS
------------
Each entry in src/_data/resources.json can have an "image" field, like:

    "image": "/images/resources/gingham-generator.png"

Drop a screenshot file into this folder with a matching filename, and it
will show up as the tile's thumbnail on the resources page.

If a resource has no "image" field (or the file is missing), the tile
automatically shows a purple gradient placeholder with a sparkle instead
of a broken-image icon — so it's always safe to leave "image" out while
you find/crop a screenshot.

RULES
-----
- Filenames must exactly match the "image" path in resources.json
  (case-sensitive on the live server, even though your computer might not
  care).
- .png or .jpg both work fine.
- A good screenshot size is roughly 800x500px (16:10) — that's the shape
  the tile crops to. Bigger is fine too, it'll get cropped to fit.
- Don't hotlink screenshots from other sites — save an actual image file
  here so the build doesn't depend on some other website staying online.

Current status: the seed entry (Gingham Generator) does NOT have an image
yet — nobody has grabbed a screenshot of it, so it intentionally shows the
placeholder tile. Add "gingham-generator.png" here and add the "image"
field back into resources.json whenever you get a screenshot.
