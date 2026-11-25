// Creates the test files that aren't stored in the repo: a sample XLSX, a 2-page PDF, and the
// standard EICAR antivirus test string (harmless, but antivirus tools flag it, so it's generated on the fly).
const fs = require("fs"), path = require("path");
const dir = path.join(__dirname, "files");
(async () => {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Aging");
  ws.addRow(["Cliente", "Proyecto", "Corriente", "1-30", "31-60", "61-90"]);
  for (let i = 1; i <= 120; i++) ws.addRow([`Cliente ${i}`, `Proyecto ${i}`, i * 100, i * 10, 0, i % 7 ? 0 : 250]);
  await wb.xlsx.writeFile(path.join(dir, "ar-aging.xlsx"));
  const pages = ["Contrato de muestra - pagina 1", "Contrato de muestra - pagina 2"];
  let objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  pages.forEach((t, i) => {
    const s = `BT /F1 24 Tf 72 720 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`);
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n", offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  fs.writeFileSync(path.join(dir, "contrato.pdf"), pdf);
  fs.writeFileSync(path.join(dir, "eicar.txt"), "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
  console.log("test files ready");
})();
