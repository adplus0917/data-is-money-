// ============================================================
// DATA Patrimonio — Valuation Engine (02-valuation-engine.js)
// Implemented exactly as supplied in the build kit.
// ONE file, used in two places:
//   - the browser loads it at /engine.js to show the estimate instantly
//   - the server requires it to recompute the estimate on submit
//     (the server's number is the one saved; the browser is never trusted)
// ALL prices live in CONFIG — change them here, restart, done.
// ============================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.CONFIG = api.CONFIG; root.valueDataset = api.valueDataset; root.ENGINE_VERSION = api.ENGINE_VERSION; }
})(typeof self !== "undefined" ? self : this, function () {
  const ENGINE_VERSION = "kit-2026-11-24";

  const CONFIG = {
    // Base price by the company's annual revenue band (USD)
    revenueBase: { "under2m": 15000, "2to5m": 30000, "5to10m": 75000, "10to20m": 150000, "over20m": 260000 },
    // Multiplier by years of records the company holds
    recordYearsFactor: { "under3": 0.60, "3to5": 0.80, "5to10": 1.00, "over10": 1.20 },
    // Multiplier by employee count (operating depth)
    employeesFactor: { "1to10": 0.80, "11to25": 0.90, "26to50": 1.00, "51to75": 1.10, "over75": 1.20 },
    // Record types: email and accounting count double
    dataTypeWeight: { invoices: 1, quotes: 1, contracts: 1, drawings: 1, photos: 1, email: 2, accounting: 2 },
    maxTypeScore: 9,      // all 7 types selected = 9 points
    typeFactorMin: 0.75,  // thinnest record set
    typeFactorMax: 1.25,  // richest record set
    // Multiplier by data format / cleanliness
    formatFactor: { "digital_structured": 1.10, "mixed": 1.00, "paper_scans": 0.80 },
    // Multiplier if the data keeps updating
    frequencyFactor: { "ongoing": 1.15, "static": 1.00 },
    // Shown range = point estimate spread by these
    rangeLow: 0.75,
    rangeHigh: 1.35,
    // Tiers by point estimate
    tiers: [
      { name: "Bronce", max: 25000 },
      { name: "Plata", max: 75000 },
      { name: "Oro", max: 200000 },
      { name: "Platino", max: Infinity },
    ],
  };

  // input = { revenueBand, recordYears, employees, dataTypes: [], format, frequency }
  function valueDataset(input) {
    const base = CONFIG.revenueBase[input.revenueBand];
    const fYears = CONFIG.recordYearsFactor[input.recordYears];
    const fEmployees = CONFIG.employeesFactor[input.employees];
    const fFormat = CONFIG.formatFactor[input.format];
    const fFrequency = CONFIG.frequencyFactor[input.frequency];

    const typeScore = input.dataTypes.reduce((sum, t) => sum + (CONFIG.dataTypeWeight[t] || 0), 0);
    const typeRatio = Math.min(typeScore / CONFIG.maxTypeScore, 1);
    const fTypes = CONFIG.typeFactorMin + typeRatio * (CONFIG.typeFactorMax - CONFIG.typeFactorMin);

    const point = Math.round(base * fYears * fEmployees * fTypes * fFormat * fFrequency);
    const low = Math.round(point * CONFIG.rangeLow / 100) * 100;
    const high = Math.round(point * CONFIG.rangeHigh / 100) * 100;
    const tier = CONFIG.tiers.find(t => point <= t.max).name;

    const score = Math.round(100 * (
      0.35 * typeRatio +
      0.25 * ((fYears - 0.6) / 0.6) +
      0.20 * ((fFormat - 0.8) / 0.3) +
      0.20 * (input.frequency === "ongoing" ? 1 : 0.6)
    ));

    return {
      point, low, high, tier,
      score: Math.max(0, Math.min(100, score)),
      breakdown: { base, fYears, fEmployees, fTypes, fFormat, fFrequency },
      disclaimer: "Estimado preliminar. El precio final se confirma " +
        "cuando verifiquemos tu documentación y una muestra de tus datos.",
    };
  }

  return { CONFIG, valueDataset, ENGINE_VERSION };
});
