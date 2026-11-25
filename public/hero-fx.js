/* ============================================================
   DATA Patrimonio — hero metrics rain (inicio view only)
   Ambient canvas layer behind the hero copy: data metrics
   gently drifting down — years, record counts, percentages.
   Decorative only: abstract values, no prices, no promises.
   Pauses when the tab is hidden or the hero is off-screen
   (including when another view replaces inicio), uses fewer
   streams on small screens, and honors prefers-reduced-motion
   with a single static frame.
   ============================================================ */
(() => {
  const canvas = document.getElementById("heroFx");
  if (!canvas) return;
  const hero = canvas.closest(".hero");
  const ctx = canvas.getContext("2d");
  if (!hero || !ctx) return;

  const VALUES = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025",
    "1,240", "8,530", "312", "764", "96%", "98%", "100%", "+12%", "+18%", "×1.2", "×1.4", "24/7"];
  const WORDS = ["datos", "registros", "facturas", "contratos", "historial", "archivos", "respaldo"];
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  let W = 0, H = 0, cols = [], raf = null, last = 0, running = false, heroVisible = false;

  function makeItem(y) {
    const word = Math.random() < 0.3;
    return {
      text: word ? pick(WORDS) : pick(VALUES),
      y,
      alpha: 0.05 + Math.random() * 0.11,
      size: 12 + Math.random() * 4,
      gold: !word && Math.random() < 0.7
    };
  }

  function build() {
    const spacing = W < 640 ? 170 : 118;
    const n = Math.max(2, Math.floor(W / spacing));
    cols = [];
    for (let i = 0; i < n; i++) {
      const items = [];
      const gap = 120 + Math.random() * 60;
      const count = Math.ceil(H / gap) + 1;
      for (let j = 0; j < count; j++) items.push(makeItem(j * gap - Math.random() * 40));
      cols.push({ x: (i + 0.5) * (W / n) + (Math.random() * 24 - 12), speed: 13 + Math.random() * 17, gap, items });
    }
  }

  function resize() {
    const r = hero.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = Math.max(280, r.width); H = Math.max(200, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    if (reducedMotion()) drawStatic();
  }

  function fade(y) { // fade streams in at the top edge and out at the bottom
    const edge = 46;
    return Math.min(1, y / edge, (H - y) / edge);
  }

  function drawItem(it, x) {
    const a = it.alpha * Math.max(0, fade(it.y));
    if (a <= 0.004) return;
    ctx.font = "600 " + it.size + "px Inter, system-ui, sans-serif";
    ctx.fillStyle = it.gold ? "rgba(230,196,82," + a + ")" : "rgba(163,179,204," + a + ")";
    ctx.fillText(it.text, x, it.y);
  }

  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    ctx.clearRect(0, 0, W, H);
    for (const c of cols) {
      const dy = c.speed * dt;
      for (const it of c.items) {
        it.y += dy;
        if (it.y > H + 24) { Object.assign(it, makeItem(it.y - c.gap * c.items.length)); }
        drawItem(it, c.x);
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function drawStatic() { // reduced motion: one quiet frame, no loop
    ctx.clearRect(0, 0, W, H);
    for (const c of cols) for (const it of c.items) drawItem(it, c.x);
  }

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function start() {
    if (running || reducedMotion()) { if (reducedMotion()) drawStatic(); return; }
    running = true; last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }
  const maybe = () => (heroVisible && !document.hidden ? start() : stop());

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(es => { heroVisible = es[0].isIntersecting; maybe(); }, { threshold: 0.04 }).observe(hero);
  } else { heroVisible = true; }
  document.addEventListener("visibilitychange", maybe);
  let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(resize, 160); });

  resize();
  maybe();
})();
