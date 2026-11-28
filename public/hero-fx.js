/* ============================================================
   DATA Patrimonio — hero treatment (approved preview, Nov 25 2026)
   Gold metrics rain + rising embers on a canvas above the hero
   veil, the owner-at-laptop video frame, and the ambient-music
   toggle. Home view only: the canvas lives inside the hero
   section, which the funnel hides on every other view.
   Ported from the approved preview Space
   (data-patrimonio-front-page-preview-alive) — behavior identical:
   rain 55–140 px/s at 22–60% alpha with light trails, embers
   rising, music behind the "Escuchar música" toggle, honest
   play state synced to the real play() promise, first-gesture
   start when the browser blocks audible autoplay.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Sound toggle + ambient music ---------- */
  var audio = document.getElementById("ambient-audio");
  var soundBtn = document.getElementById("sound-toggle");
  var iconOff = document.getElementById("sound-icon-off");
  var iconOn = document.getElementById("sound-icon-on");
  var soundLabel = document.getElementById("sound-label");
  /* The visitor's music choice persists across steps, pages and reloads
     (localStorage, key dp-music-pref: "off" | "on"; absent = no explicit
     choice yet). Once a visitor turns the music off it stays off — the
     first-gesture starter below never overrides a stored "off" — until
     they turn it back on. Storage failures (private mode) fall back to
     the in-memory flag for the current page only. */
  var MUSIC_PREF_KEY = "dp-music-pref";
  function readMusicPref() {
    try { return window.localStorage.getItem(MUSIC_PREF_KEY); } catch (e) { return null; }
  }
  function saveMusicPref(v) {
    try { window.localStorage.setItem(MUSIC_PREF_KEY, v); } catch (e) { /* storage blocked: in-memory flag still applies */ }
  }
  var userStoppedMusic = readMusicPref() === "off";

  function soundStrings() {
    var lang = document.documentElement.lang === "es" ? "es" : "en";
    if (typeof T !== "undefined" && T[lang] && T[lang].soundOff) {
      return { off: T[lang].soundOff, on: T[lang].soundOn };
    }
    return lang === "es"
      ? { off: "Escuchar música", on: "Música activada" }
      : { off: "Listen to music", on: "Music on" };
  }
  function setSoundUI(playing) {
    if (!soundBtn) { return; }
    soundBtn.setAttribute("aria-pressed", playing ? "true" : "false");
    if (iconOff) { iconOff.style.display = playing ? "none" : ""; }
    if (iconOn) { iconOn.style.display = playing ? "" : "none"; }
    if (soundLabel) { soundLabel.textContent = playing ? soundStrings().on : soundStrings().off; }
  }
  function tryPlayMusic() {
    if (!audio || !audio.paused) { return; }
    var p = audio.play();
    if (p && p.then) {
      p.then(function () { setSoundUI(true); }).catch(function () { setSoundUI(false); });
    } else {
      setSoundUI(!audio.paused);
    }
  }
  if (audio && soundBtn) {
    audio.volume = 0.5;
    if (audio.load) { audio.load(); }
    soundBtn.addEventListener("click", function () {
      if (audio.paused) {
        userStoppedMusic = false;
        saveMusicPref("on");
        tryPlayMusic();
      } else {
        userStoppedMusic = true;
        saveMusicPref("off");
        audio.pause();
        setSoundUI(false);
      }
    });
    audio.addEventListener("playing", function () { setSoundUI(true); });
    audio.addEventListener("pause", function () { setSoundUI(false); });
    /* Browsers block audible autoplay, so try immediately and, if the
       browser refuses, start on the visitor's first tap, click or key
       press anywhere on the page (unless they turned the music off —
       a stored "off" is honored from the first line, so returning
       visitors and mid-funnel reloads stay silent). */
    if (userStoppedMusic) { setSoundUI(false); } else { tryPlayMusic(); }
    var armFirstGesture = function (e) {
      if (userStoppedMusic) { return; }
      if (e && e.target && e.target.closest && e.target.closest("#sound-toggle")) { return; }
      tryPlayMusic();
    };
    document.addEventListener("pointerdown", armFirstGesture);
    document.addEventListener("keydown", armFirstGesture);
    document.addEventListener("touchend", armFirstGesture);
  }

  /* ---------- Hero canvas: gold rain + rising embers ---------- */
  var hero = document.querySelector(".hero");
  var canvas = document.getElementById("hero-canvas");
  if (!hero || !canvas) { return; }
  var ctx = canvas.getContext("2d");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  var YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];
  var WORDS = ["datos", "facturas", "registros", "contratos", "historial"];
  var COUNTS = ["65%", "100%", "35%", "0 a 100", "1,240", "860", "3,150", "420", "98%", "12,480", "7,300", "540"];

  function pickGlyph() {
    var r = Math.random();
    if (r < 0.30) { return DIGITS[(Math.random() * DIGITS.length) | 0]; }
    if (r < 0.55) { return YEARS[(Math.random() * YEARS.length) | 0]; }
    if (r < 0.80) { return WORDS[(Math.random() * WORDS.length) | 0]; }
    return COUNTS[(Math.random() * COUNTS.length) | 0];
  }

  var W = 0, H = 0, dpr = 1;
  var rain = [], embers = [];
  var running = false, rafId = null, lastTs = 0, heroVisible = true;

  function newEmber(anywhere) {
    return {
      x: Math.random() * W,
      y: anywhere ? Math.random() * H : H + 6,
      r: 0.8 + Math.random() * 1.5,
      vy: 13 + Math.random() * 20,
      sway: 6 + Math.random() * 12,
      phase: Math.random() * Math.PI * 2,
      speedPhase: 0.4 + Math.random() * 0.6,
      life: anywhere ? Math.random() : 0,
      maxLife: 6 + Math.random() * 6
    };
  }
  function buildScene() {
    var narrow = W < 640;
    var targetRain = narrow ? Math.max(22, Math.round(W / 18)) : Math.round(W / 15);
    targetRain = Math.min(targetRain, 96);
    rain = [];
    for (var i = 0; i < targetRain; i++) {
      rain.push({
        x: Math.random() * W,
        y: Math.random() * (H + 120) - 60,
        speed: 55 + Math.random() * 85,
        text: pickGlyph(),
        alpha: 0.22 + Math.random() * 0.38,
        size: 13 + Math.random() * 7,
        slate: Math.random() < 0.3,
        trail: 26 + Math.random() * 46
      });
    }
    var targetEmbers = narrow ? 18 : 32;
    embers = [];
    for (var j = 0; j < targetEmbers; j++) { embers.push(newEmber(true)); }
  }
  function resize() {
    var rect = hero.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildScene();
    if (reduced) { drawFrame(0); }
  }
  function drawFrame(dt) {
    ctx.clearRect(0, 0, W, H);
    var t = performance.now() / 1000;
    var i, it, fade;
    /* rain */
    ctx.textBaseline = "top";
    for (i = 0; i < rain.length; i++) {
      it = rain[i];
      it.y += it.speed * dt;
      if (it.y > H + 30) {
        it.y = -24 - Math.random() * 40;
        it.x = Math.random() * W;
        it.text = pickGlyph();
        it.speed = 55 + Math.random() * 85;
        it.alpha = 0.22 + Math.random() * 0.38;
        it.size = 13 + Math.random() * 7;
        it.trail = 26 + Math.random() * 46;
      }
      fade = 1;
      if (it.y < 50) { fade = Math.max(0, (it.y + 24) / 74); }
      if (it.y > H - 70) { fade = Math.max(0, (H - it.y) / 70); }
      /* light trail above each falling glyph, so the fall reads clearly */
      var trailGrad = ctx.createLinearGradient(0, it.y - it.trail, 0, it.y);
      if (it.slate) {
        trailGrad.addColorStop(0, "rgba(148,168,200,0)");
        trailGrad.addColorStop(1, "rgba(148,168,200," + (it.alpha * 0.45 * fade).toFixed(3) + ")");
      } else {
        trailGrad.addColorStop(0, "rgba(217,188,122,0)");
        trailGrad.addColorStop(1, "rgba(217,188,122," + (it.alpha * 0.45 * fade).toFixed(3) + ")");
      }
      ctx.fillStyle = trailGrad;
      ctx.fillRect(it.x + it.size * 0.28, it.y - it.trail, 1.6, it.trail);
      ctx.font = "600 " + it.size.toFixed(1) + "px Inter, sans-serif";
      if (it.slate) {
        ctx.fillStyle = "rgba(178,196,226," + (it.alpha * fade).toFixed(3) + ")";
      } else {
        ctx.fillStyle = "rgba(233,205,145," + (it.alpha * fade).toFixed(3) + ")";
      }
      ctx.fillText(it.text, it.x, it.y);
    }
    /* embers */
    for (i = 0; i < embers.length; i++) {
      var e = embers[i];
      e.life += dt / e.maxLife;
      e.y -= e.vy * dt;
      var x = e.x + Math.sin(t * e.speedPhase + e.phase) * e.sway;
      if (e.life >= 1 || e.y < -10) { embers[i] = newEmber(false); continue; }
      var a = Math.sin(Math.min(e.life, 1) * Math.PI) * 0.55;
      ctx.beginPath();
      ctx.arc(x, e.y, e.r * 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(217,188,122," + (a * 0.14).toFixed(3) + ")";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, e.y, e.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(233,205,145," + a.toFixed(3) + ")";
      ctx.fill();
    }
  }
  function loop(ts) {
    if (!running) { return; }
    var dt = Math.min((ts - lastTs) / 1000 || 0.016, 0.05);
    lastTs = ts;
    drawFrame(dt);
    rafId = requestAnimationFrame(loop);
  }
  function start() {
    if (running || reduced) { return; }
    running = true;
    lastTs = performance.now();
    rafId = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }
  function updateRunState() {
    /* the hero is hidden (class .hide) on every non-home view */
    if (heroVisible && !document.hidden && !hero.classList.contains("hide")) { start(); } else { stop(); }
  }
  /* view switches toggle .hide on the hero — keep the loop in sync */
  if ("MutationObserver" in window) {
    new MutationObserver(updateRunState).observe(hero, { attributes: true, attributeFilter: ["class"] });
  }
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 160);
  });
  document.addEventListener("visibilitychange", updateRunState);
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      heroVisible = entries[0].isIntersecting;
      updateRunState();
    }, { threshold: 0.04 });
    io.observe(hero);
  }

  resize();
  if (reduced) {
    drawFrame(0);
  } else {
    updateRunState();
  }
})();
