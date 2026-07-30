(function () {
  "use strict";

  const sections = Array.from(document.querySelectorAll(".travel-map-section"));
  const tooltip = document.getElementById("map-tooltip");

  if (sections.length === 0 || !tooltip) return;

  const DEFAULT_STROKE_WIDTH = "1";
  const HOVER_STROKE_WIDTH = "2.5";

  function titleTextFor(el) {
    const titleEl = el.querySelector("title");
    return titleEl ? titleEl.textContent : null;
  }

  function showTooltip(el, x, y) {
    const name = el.getAttribute("data-name");
    const status = el.getAttribute("data-status");
    const label = el.getAttribute("data-tooltip") || titleTextFor(el) || `${name} — ${status}`;
    tooltip.textContent = label;
    tooltip.hidden = false;
    positionTooltip(x, y);
  }

  function positionTooltip(x, y) {
    tooltip.style.left = `${x + 14}px`;
    tooltip.style.top = `${y + 14}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  // Each map section (US, and every regional map) is wired up independently:
  // its own shapes, its own legend, its own activeStatus. Highlighting a
  // category on one map must never affect any other map on the page. The
  // page-level tooltip element is the one thing shared across all sections.
  sections.forEach((section) => {
    const places = Array.from(section.querySelectorAll("[data-place]"));
    const legendRows = Array.from(section.querySelectorAll(".map-legend-row"));

    if (places.length === 0) return;

    places.forEach((el) => {
      el.addEventListener("mouseenter", (e) => {
        el.setAttribute("stroke-width", HOVER_STROKE_WIDTH);
        showTooltip(el, e.pageX, e.pageY);
      });

      el.addEventListener("mousemove", (e) => {
        positionTooltip(e.pageX, e.pageY);
      });

      el.addEventListener("mouseleave", () => {
        el.setAttribute("stroke-width", DEFAULT_STROKE_WIDTH);
        hideTooltip();
      });

      el.addEventListener("focus", () => {
        el.setAttribute("stroke-width", HOVER_STROKE_WIDTH);
        const rect = el.getBoundingClientRect();
        showTooltip(el, rect.left + window.scrollX + rect.width / 2, rect.top + window.scrollY);
      });

      el.addEventListener("blur", () => {
        el.setAttribute("stroke-width", DEFAULT_STROKE_WIDTH);
        hideTooltip();
      });
    });

    // Legend click/keyboard: highlight all places in that status within
    // this section, dim the rest. Clicking the same row again resets to
    // the normal view.
    let activeStatus = null;

    function applyHighlight(status) {
      places.forEach((el) => {
        const matches = status === null || el.getAttribute("data-status") === status;
        el.style.opacity = matches ? "1" : "0.35";
      });
      legendRows.forEach((row) => {
        row.classList.toggle("is-active", row.getAttribute("data-status") === status);
      });
    }

    function toggleLegend(row) {
      const status = row.getAttribute("data-status");
      activeStatus = activeStatus === status ? null : status;
      applyHighlight(activeStatus);
    }

    legendRows.forEach((row) => {
      row.addEventListener("click", () => toggleLegend(row));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleLegend(row);
        }
      });
    });
  });
})();
