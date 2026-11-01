import { dayNumber } from "./core/dates.ts";
import { loadFile, type LoanFile } from "./core/file.ts";
import { dollars } from "./core/format.ts";
import { formatInterval, type Interval } from "./core/interval.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreReader, type HandKeyed } from "./dscr/eval.ts";
import { dscrCheck, type DscrRequest } from "./dscr/index.ts";
import { MORTGAGE_KINDS, lienstack, type LienRequest } from "./lienstack/index.ts";

const money = dollars;
const pct = (n: number) => `${n.toFixed(2)}%`;
const range = (x: Interval, unit: (n: number) => string) => formatInterval(x, unit);
const mark = { pass: "PASS   ", fail: "FAIL   ", unknown: "CAN'T TELL" } as const;

interface Flags {
  readonly asOf?: string;
  readonly json: boolean;
}

/** The file as given, judged on another day when `--as-of` names one. */
function load<R extends { asOf: string }>(path: string, flags: Flags): LoanFile<R> {
  const file = loadFile<R>(path);
  return flags.asOf ? { ...file, request: { ...file.request, asOf: flags.asOf } } : file;
}

/** JSON with unbounded range ends spelled out, since JSON has no Infinity. */
function json(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === Infinity ? "unbounded" : v), 2);
}

function printLiens(path: string, flags: Flags): void {
  const r = lienstack(load<LienRequest>(path, flags));
  if (flags.json) return void console.log(json(r));
  console.log(`lienstack ${r.file}  as of ${r.asOf}  policy ${r.policy}`);
  console.log(`file sha256 ${r.sha256}`);
  console.log(`current report: ${r.report.current ?? "none"}${r.report.effective ? ` (effective ${r.report.effective})` : ""}${r.report.superseded.length ? `; superseded: ${r.report.superseded.join(", ")}` : ""}`);
  console.log("\nliens");
  for (const l of r.liens) {
    console.log(`  item ${l.item}  ${l.kind}  ${l.instrument ?? "instrument not backed"}  recorded ${l.recorded ?? "not backed"}  amount ${l.amount === null ? "not backed" : money(l.amount)}  ${l.stays === "yes" ? "" : l.stays}`);
    if (MORTGAGE_KINDS.includes(l.kind)) console.log(`    balance ${range(l.balance, money)}  (${l.balanceBecause})`);
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

function printDscr(path: string, flags: Flags): void {
  const r = dscrCheck(load<DscrRequest>(path, flags));
  if (flags.json) return void console.log(json(r));
  const ratio = (n: number) => n.toFixed(3);
  console.log(`dscr-check ${r.file}  as of ${r.asOf}  policy ${r.policy}`);
  console.log(`file sha256 ${r.sha256}`);
  console.log(`\npages routed: ${r.routed.map((p) => `${p.doc} p.${p.page} ${p.cls}`).join(", ")}`);
  console.log(`for a person to review: ${r.review.length}${r.review.length ? ` (${r.review.map((p) => `${p.doc} p.${p.page}`).join(", ")})` : ""}`);
  console.log("\nparts (monthly)");
  for (const p of r.parts) console.log(`  ${p.name.padEnd(22)} ${range(p.value, money).padEnd(26)} ${p.because}`);
  if (r.problems.length) {
    console.log("\nheld or unsupported");
    for (const p of r.problems) console.log(`  ${p.status}  ${p.field}  ${p.doc} p.${p.page}: ${p.reason}`);
  }
  console.log(`\nqualifying rent ${range(r.rent, money)}   PITIA ${range(r.pitia, money)}   DSCR ${range(r.dscr, ratio)}`);
  for (const o of r.overlays) console.log(`  ${mark[o.status].padEnd(10)}  ${o.overlay.name}: DSCR at least ${o.overlay.minDscr.toFixed(2)}`);
  for (const n of r.needs) console.log(`  needs ${n}`);
}

function printEval(dir: string): void {
  const files = readdirSync(dir).filter((n) => /^dscr-\d+\.json$/.test(n)).sort().map((n) => loadFile<DscrRequest>(join(dir, n)));
  const keyed = JSON.parse(readFileSync(join(dir, "hand-keyed.json"), "utf8")) as HandKeyed;
  const s = scoreReader(files, keyed);
  console.log(`reference reader on ${files.length} synthetic files in ${dir}`);
  console.log(`  fields keyed ${s.fields}  correct ${s.correct}  missed ${s.missed}  wrong ${s.wrong}`);
  console.log(`  proposals ${s.claims}  held ${s.held}  unsupported ${s.unsupported}`);
  console.log(`  accuracy ${(s.accuracy * 100).toFixed(1)}%  unsupported rate ${(s.unsupportedRate * 100).toFixed(1)}%  held rate ${(s.heldRate * 100).toFixed(1)}%`);
}

const USAGE = "groundcheck usage: node src/cli.ts lienstack <file.json> | dscr <file.json> [--as-of YYYY-MM-DD] [--json] | eval [dir]";

function fail(message: string): void {
  console.error(message);
  process.exitCode = 2;
}

const args = process.argv.slice(2);
const positional: string[] = [];
let asOf: string | undefined;
let asJson = false;
let bad: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "--json") asJson = true;
  else if (arg === "--as-of") {
    asOf = args[i + 1];
    i += 1;
    if (asOf === undefined || dayNumber(asOf) === null) bad = `--as-of needs a real day as YYYY-MM-DD, not "${asOf ?? ""}"`;
  } else if (arg.startsWith("--")) bad = `unknown flag ${arg}`;
  else positional.push(arg);
}
const flags: Flags = asOf === undefined ? { json: asJson } : { asOf, json: asJson };
const [command, path] = positional;
if (bad) fail(`${bad}\n${USAGE}`);
else if (command === "lienstack" && path) printLiens(path, flags);
else if (command === "dscr" && path) printDscr(path, flags);
else if (command === "eval") printEval(path ?? "examples/dscr");
else fail(USAGE);
