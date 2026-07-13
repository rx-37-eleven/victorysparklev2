(function () {
  "use strict";

  // Filter semantics: with multiple tags selected, show resources that have
  // ANY of the selected tags (logical OR). Flip this to `true` to require
  // ALL selected tags instead (logical AND) — everything below already
  // branches on this single flag, no other changes needed.
  const MATCH_ALL = false;

  const grid = document.getElementById("resource-grid");
  const tiles = Array.from(document.querySelectorAll(".resource-tile"));
  const countEl = document.getElementById("resource-count");
  const emptyStateEl = document.getElementById("resource-empty-state");
  const clearBtn = document.getElementById("clear-filters-btn");
  const allChips = Array.from(document.querySelectorAll(".tag-chip"));

  if (!grid || tiles.length === 0) return;

  const activeTags = new Set();

  function tileTags(tile) {
    const raw = tile.getAttribute("data-tags") || "";
    return raw.split(" ").filter(Boolean);
  }

  function tileMatches(tile) {
    if (activeTags.size === 0) return true;
    const tags = tileTags(tile);
    if (MATCH_ALL) {
      return Array.from(activeTags).every((t) => tags.includes(t));
    }
    return Array.from(activeTags).some((t) => tags.includes(t));
  }

  function render() {
    let visibleCount = 0;
    tiles.forEach((tile) => {
      const matches = tileMatches(tile);
      tile.hidden = !matches;
      if (matches) visibleCount += 1;
    });

    countEl.textContent = `Showing ${visibleCount} of ${tiles.length} resource${tiles.length === 1 ? "" : "s"}`;
    emptyStateEl.hidden = visibleCount !== 0;

    allChips.forEach((chip) => {
      const tag = chip.getAttribute("data-tag");
      const isActive = activeTags.has(tag);
      chip.classList.toggle("is-active", isActive);
      chip.setAttribute("aria-pressed", String(isActive));
    });

    clearBtn.hidden = activeTags.size === 0;

    syncHash();
  }

  function syncHash() {
    const hash = activeTags.size
      ? `#tags=${Array.from(activeTags).join(",")}`
      : "";
    const url = window.location.pathname + window.location.search + hash;
    history.replaceState(null, "", url);
  }

  function readHash() {
    const match = window.location.hash.match(/tags=([^&]*)/);
    if (!match) return;
    const tags = decodeURIComponent(match[1]).split(",").filter(Boolean);
    tags.forEach((t) => activeTags.add(t));
  }

  function toggleTag(tag) {
    if (activeTags.has(tag)) {
      activeTags.delete(tag);
    } else {
      activeTags.add(tag);
    }
    render();
  }

  allChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      toggleTag(chip.getAttribute("data-tag"));
    });
  });

  clearBtn.addEventListener("click", () => {
    activeTags.clear();
    render();
  });

  readHash();
  render();
})();
