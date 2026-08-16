// Homepage-only interactivity: the "a look around" photo carousel and the
// dismissible floating shop tab. Vanilla JS, same style as nav.js -- no
// dependencies, since this is a plain Eleventy site.
document.addEventListener("DOMContentLoaded", function () {
  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- Photo carousel -----------------------------------------------------
  var track = document.querySelector("[data-carousel-track]");
  if (track) {
    var slides = Array.prototype.slice.call(track.children);
    var caption = document.querySelector("[data-carousel-caption]");
    var dots = Array.prototype.slice.call(document.querySelectorAll("[data-carousel-goto]"));
    var prevBtn = document.querySelector("[data-carousel-prev]");
    var nextBtn = document.querySelector("[data-carousel-next]");
    var index = 0;
    var AUTOPLAY_MS = 5000;
    var timer;

    function render() {
      track.style.transform = "translateX(" + -index * 100 + "%)";
      if (caption && slides[index]) caption.textContent = slides[index].dataset.caption || "";
      dots.forEach(function (dot, i) {
        dot.classList.toggle("is-active", i === index);
      });
    }

    function arm() {
      if (prefersReducedMotion) return;
      clearTimeout(timer);
      timer = setTimeout(function () {
        goTo(index + 1);
      }, AUTOPLAY_MS);
    }

    function goTo(n) {
      index = (n + slides.length) % slides.length;
      render();
      arm();
    }

    if (prevBtn) prevBtn.addEventListener("click", function () { goTo(index - 1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { goTo(index + 1); });
    dots.forEach(function (dot) {
      dot.addEventListener("click", function () {
        goTo(parseInt(dot.getAttribute("data-carousel-goto"), 10));
      });
    });

    render();
    arm();
  }

  // --- Floating shop tab dismiss ------------------------------------------
  var shopTab = document.getElementById("home-shop-tab");
  var dismissBtn = document.getElementById("home-shop-tab-dismiss");
  if (shopTab && dismissBtn) {
    dismissBtn.addEventListener("click", function () {
      shopTab.classList.add("is-dismissed");
    });
  }
});
