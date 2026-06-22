/* ===========================================================
   Jottr site - parallax + 3D tilt for the hero shot.
   Pure vanilla JS, no deps.
   =========================================================== */

(function () {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // -------- Parallax --------------------------------------------------
  // Three layers each move at a different rate as the user scrolls.
  const layers = document.querySelectorAll(".parallax .layer");
  let scrollY = window.scrollY;
  let pointerX = 0, pointerY = 0;

  function tick() {
    if (reduceMotion) return;
    layers.forEach((layer) => {
      const depth = parseFloat(layer.dataset.depth || "0.1");
      const y = -scrollY * depth + pointerY * depth * 6;
      const x = pointerX * depth * 6;
      layer.style.transform =
        "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)";
    });
    requestAnimationFrame(tick);
  }

  window.addEventListener("scroll", () => {
    scrollY = window.scrollY;
  }, { passive: true });

  window.addEventListener("pointermove", (e) => {
    const nx = (e.clientX / window.innerWidth) - 0.5;
    const ny = (e.clientY / window.innerHeight) - 0.5;
    pointerX = nx;
    pointerY = ny;
  }, { passive: true });

  if (!reduceMotion) requestAnimationFrame(tick);

  // -------- Tilt ------------------------------------------------------
  const tilt = document.querySelector("[data-tilt]");
  if (tilt && !reduceMotion) {
    const img = tilt.querySelector("img");
    tilt.addEventListener("pointermove", (e) => {
      const r = tilt.getBoundingClientRect();
      const rx = ((e.clientY - r.top) / r.height - 0.5) * -8;
      const ry = ((e.clientX - r.left) / r.width - 0.5) * 12;
      img.style.transform =
        "rotateX(" + rx.toFixed(2) + "deg) rotateY(" + ry.toFixed(2) + "deg)";
    });
    tilt.addEventListener("pointerleave", () => {
      img.style.transform = "rotateX(0deg) rotateY(0deg)";
    });
  }

  // -------- Reveal on scroll -----------------------------------------
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.1 }
    );
    document.querySelectorAll(".feature, .screen, .dl-card").forEach((el) => {
      el.classList.add("reveal");
      io.observe(el);
    });
  }
})();
