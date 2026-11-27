/* ============================================================
   DATA Patrimonio — SCREENING page entry (Nov 27 2026, Miguel's
   direct order). The reels link HERE, not to the homepage: this
   page opens directly on the screening questions.

   How it works: the site has ONE funnel (public/app.js) which
   shows its windows by "view" — the homepage default is the
   welcome view ("inicio"), which is why the homepage link landed
   people on the main page instead of the questions. This script
   runs BEFORE app.js and points the shared tab session at the
   funnel view ("valua"), so the funnel renders its first
   question immediately — no hero, no welcome, no extra tap.

   It also raises window.__DP_SCREEN, which app.js reads for the
   screening page's two hard gates: a REAL phone number is
   required here (optional on the homepage gate), and the
   valuation step shows the RANGE only. Everything else — the
   exact questions and wording, the email gate (valid format +
   real domain), the lead save into the CRM with its 1–10 score,
   the valuation engine, the 2 PM Zoom booking — is the site's
   one funnel, untouched.
   ============================================================ */
(() => {
  window.__DP_SCREEN = true;
  try {
    const k = "dp.session";
    const s = JSON.parse(sessionStorage.getItem(k)) || {};
    s.view = "valua";
    sessionStorage.setItem(k, JSON.stringify(s));
  } catch (e) { /* storage unavailable: app.js falls back to its defaults */ }
})();
