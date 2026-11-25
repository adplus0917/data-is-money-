// Runs the build kit's four validation profiles through server/engine.js.
// Usage: npm run validate
const { valueDataset } = require("../server/engine");
const P = [
  ["A (3 lowest-weight types)", { employees: "1to10", revenueBand: "2to5m", recordYears: "3to5", dataTypes: ["invoices","quotes","contracts"], format: "mixed", frequency: "static" }, [21000, 49000], "point"],
  ["A (3 types incl. email+accounting)", { employees: "1to10", revenueBand: "2to5m", recordYears: "3to5", dataTypes: ["invoices","email","accounting"], format: "mixed", frequency: "static" }, [21000, 49000], "point"],
  ["B (Miguel's case)", { employees: "1to10", revenueBand: "5to10m", recordYears: "5to10", dataTypes: ["invoices","quotes","contracts","email"], format: "mixed", frequency: "static" }, [47000, 89000], "near"],
  ["C", { employees: "26to50", revenueBand: "5to10m", recordYears: "5to10", dataTypes: ["invoices","quotes","contracts","email","accounting"], format: "digital_structured", frequency: "static" }, [74000, 172000], "point"],
  ["D", { employees: "51to75", revenueBand: "over20m", recordYears: "over10", dataTypes: ["invoices","quotes","contracts","drawings","photos","email","accounting"], format: "digital_structured", frequency: "ongoing" }, [275000, 450000], "point"],
];
const $ = n => "$" + n.toLocaleString("en-US");
for (const [name, inp, exp, on] of P) {
  const v = valueDataset(inp), b = v.breakdown;
  const ok = on === "near" ? v.low >= exp[0] * 0.95 && v.high <= exp[1] * 1.05 : v.point >= exp[0] && v.point <= exp[1];
  console.log(`${ok ? "PASS" : "MISS"}  ${name}`);
  console.log(`      ${$(b.base)} × ${b.fYears} × ${b.fEmployees} × ${b.fTypes.toFixed(3)} × ${b.fFormat} × ${b.fFrequency} = ${$(v.point)}`);
  console.log(`      range ${$(v.low)} – ${$(v.high)} · ${v.tier} · score ${v.score} · kit expects ${$(exp[0])} – ${$(exp[1])}${on === "near" ? " (range)" : " (point)"}`);
}
