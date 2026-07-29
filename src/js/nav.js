// Header dropdown menus (Make / Code / Enjoy / Contact).
// CSS handles hover-to-open on mouse/trackpad; this handles click/tap
// (touch screens, and mouse users who just click instead of hovering)
// plus closing on outside click and Escape.
document.addEventListener("DOMContentLoaded", function () {
  var items = Array.prototype.slice.call(document.querySelectorAll(".nav-item"));
  if (!items.length) return;

  function closeAll(except) {
    items.forEach(function (item) {
      if (item === except) return;
      item.classList.remove("open");
      var trigger = item.querySelector(".nav-trigger");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
  }

  items.forEach(function (item) {
    var trigger = item.querySelector(".nav-trigger");
    if (!trigger) return;

    trigger.addEventListener("click", function (e) {
      e.preventDefault();
      var isOpen = item.classList.contains("open");
      closeAll(item);
      item.classList.toggle("open", !isOpen);
      trigger.setAttribute("aria-expanded", String(!isOpen));
    });
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".nav-item")) closeAll();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAll();
  });

  // --- Active page indicator -------------------------------------------
  // Marks the nav link matching the current URL, and the dropdown trigger
  // that contains it. Runs at runtime rather than build time so the
  // passthrough-copied app pages under /apps/ get it too.
  (function markCurrentPage() {
    function normalize(p) {
      if (!p) return null;
      p = p.split("#")[0].split("?")[0];
      p = p.replace(/index\.html$/, "");
      if (p.charAt(p.length - 1) !== "/") p += "/";
      return p;
    }

    var here = normalize(location.pathname);

    document.querySelectorAll(".main-nav a[href]").forEach(function (link) {
      var href = link.getAttribute("href");
      // Only same-site absolute paths. Skips external links and bare anchors.
      if (!href || href.charAt(0) !== "/") return;
      if (normalize(href) !== here) return;

      link.classList.add("is-current");
      link.setAttribute("aria-current", "page");

      var parent = link.closest(".nav-item");
      if (parent) parent.classList.add("has-current");
    });
  })();
});
