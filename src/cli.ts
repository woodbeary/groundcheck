import { loadFile } from "./core/file.ts";
import { formatInterval, type Interval } from "./core/interval.ts";
import { lienstack, type LienRequest } from "./lienstack/index.ts";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n.toFixed(2)}%`;
const range = (x: Interval, unit: (n: number) => string) => formatInterval(x, unit);
const mark = { pass: "PASS   ", fail: "FAIL   ", unknown: "CAN'T TELL" } as const;

function printLiens(path: string): void {
  const r = lienstack(loadFile<LienRequest>(path));
  console.log(`lienstack ${r.file}  as of ${r.asOf}  policy ${r.policy}`);
  console.log(`current report: ${r.report.current ?? "none"}${r.report.effective ? ` (effective ${r.report.effective})` : ""}${r.report.superseded.length ? `; superseded: ${r.report.superseded.join(", ")}` : ""}`);
  console.log("\nliens");
  for (const l of r.liens) {
    console.log(`  item ${l.item}  ${l.kind}  ${l.instrument ?? "instrument not backed"}  recorded ${l.recorded ?? "not backed"}  amount ${l.amount === null ? "not backed" : money(l.amount)}  ${l.stays === "yes" ? "" : l.stays}`);
    if (l.kind !== "tax-lien" && l.kind !== "judgment") console.log(`    balance ${range(l.balance, money)}  (${l.balanceBecause})`);
  }
  if (r.problems.length) {
    console.log("\nheld or unsupported");
    for (const p of r.problems) console.log(`  ${p.status}  ${p.field}  ${p.doc} p.${p.page}: ${p.reason}`);
  }
  console.log("\nchecks");
  for (const c of r.checks) console.log(`  ${mark[c.status].padEnd(10)}  ${c.id.padEnd(19)} ${c.because}`);
  console.log(`\nCLTV ${range(r.cltv, pct)}`);
  console.log(`verdict: ${mark[r.verdict].trim()}`);
  for (const c of r.conditions) console.log(`condition: ${c}`);
  console.log(`not read from title here: ${r.notReadHere.join("; ")}`);
  console.log(`\nfor the HELOC engine: otherLoan=${r.heloc.otherLoan}  balance=${range(r.heloc.balance, money)}  otherBalance=${range(r.heloc.otherBalance, money)}`);
}

const [command, path] = process.argv.slice(2);
if (command === "lienstack" && path) printLiens(path);
else {
  console.error("usage: node src/cli.ts lienstack <file.json>");
  process.exitCode = 2;
}
