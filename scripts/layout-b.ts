/**
 * The second synthetic layout: a title commitment shaped like the ALTA Commitment for Title
 * Insurance (2021 v. 01.00): Schedule A, then Schedule B Part I (requirements) and Part II
 * (exceptions), both numbered from 1. It is a different generator from the hand-written layout-A
 * preliminary reports, with its own wording, page breaks and traps, planted in different places:
 *
 * - a merged recording date (alta-02), a footnote mark on a statement balance (alta-03) and two
 *   amounts run together on a tax lien (alta-09), each of which must come back held;
 * - two commitments with the same Commitment Date (alta-04), a subordination (alta-05), a
 *   Part I requirement to release a deed of trust that Part II still lists (alta-06), a line of
 *   credit whose kind is printed on the item's second line (alta-07), a missing Part II page
 *   (alta-08), wire instructions in the file (alta-10), a stale commitment (alta-11), and a
 *   superseded commitment with its items in another order (alta-12);
 * - a deed of trust that prints a "dated" day and a "recorded" day in the same item, and the
 *   standard exceptions, which mention liens without being one.
 *
 * Every file is synthetic. Run `node scripts/layout-b.ts --write` to regenerate
 * examples/title-b; a test fails if the committed files differ from this generator's output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Ideal {
  readonly doc: string;
  readonly page: number;
  readonly field: string;
  readonly value: string | number;
  /** The shortest text on the page that prints the value with its label. */
  readonly quote: string;
  /** The printed value can't be read as one value; a correct reader's proposal comes back held. */
  readonly mustHold?: true;
}

export interface Generated {
  readonly id: string;
  readonly note: string;
  readonly expect: "pass" | "fail" | "unknown";
  /** The commitment that is current on the request date, or null when none can be (two share the newest date). */
  readonly current: string | null;
  readonly json: unknown;
  readonly ideal: readonly Ideal[];
}

type Line = string;

interface Item {
  readonly lines: readonly Line[];
  readonly fields: readonly Omit<Ideal, "doc" | "page">[];
}

const HEAD = "SYNTHETIC TEST DOCUMENT. Every name, address and number here is invented.";

const STANDARD: readonly Item[] = [
  "Any defect, lien, encumbrance, adverse claim, or other matter that appears for the first time in the Public Records or is created, attaches, or is disclosed between the Commitment Date and the date on which all of the Schedule B, Part I-Requirements are met.",
  "Rights or claims of parties in possession not shown by the Public Records.",
  "Easements, or claims of easements, not shown by the Public Records.",
  "Any lien, or right to a lien, for services, labor or material heretofore or hereafter furnished, imposed by law and not shown by the Public Records.",
  "Taxes or special assessments that are not shown as existing liens by the Public Records.",
].map((text) => ({ lines: [text], fields: [{ field: "kind", value: "other", quote: "" }] }));

const TAXES: Item = { lines: ["General and special taxes and assessments for the fiscal year 2026-2027, a lien not yet due or payable."], fields: [{ field: "kind", value: "property-taxes", quote: "" }] };

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => `${MONTH[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const slashDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function easement(recorded: string, docNo: string): Item {
  const r = `recorded ${longDate(recorded)}`;
  return {
    lines: [`Easement in favor of Synthetic Power and Light Co. for underground utilities, ${r} as Document No. ${docNo}.`],
    fields: [
      { field: "kind", value: "other", quote: "" },
      { field: "recorded", value: recorded, quote: r },
      { field: "instrument", value: docNo, quote: `Document No. ${docNo}` },
    ],
  };
}

function ccrs(recorded: string, docNo: string): Item {
  const r = `recorded ${longDate(recorded)}`;
  return {
    lines: [`Covenants, conditions and restrictions ${r} as Document No. ${docNo}.`],
    fields: [
      { field: "kind", value: "other", quote: "" },
      { field: "recorded", value: recorded, quote: r },
      { field: "instrument", value: docNo, quote: `Document No. ${docNo}` },
    ],
  };
}

interface DeedOptions {
  readonly amount: number;
  readonly dated: string;
  readonly recorded: string;
  readonly docNo: string;
  readonly beneficiary: string;
  readonly line?: boolean;
  /** Printed in place of the recording date, as merged-edit residue. */
  readonly recordedPrinted?: string;
}

function deed(o: DeedOptions): Item {
  const recordedText = `recorded ${o.recordedPrinted ?? longDate(o.recorded)}`;
  const first = o.line ? "A Deed of Trust and Assignment of Rents" : "A Deed of Trust and Assignment of Rents to secure an original principal";
  const lines = o.line
    ? [
        `${first}`,
        `(Revolving Line of Credit) to secure an original principal amount of ${money(o.amount)}, dated ${longDate(o.dated)},`,
        `${recordedText} as Document No. ${o.docNo} of Official Records.`,
        `Trustor: Pat Sample and Lee Sample. Beneficiary: ${o.beneficiary}.`,
      ]
    : [
        `${first} amount of ${money(o.amount)}, dated ${longDate(o.dated)},`,
        `${recordedText} as Document No. ${o.docNo} of Official Records.`,
        `Trustor: Pat Sample and Lee Sample. Beneficiary: ${o.beneficiary}.`,
      ];
  return {
    lines,
    fields: [
      { field: "kind", value: o.line ? "credit-line-deed-of-trust" : "deed-of-trust", quote: "" },
      o.recordedPrinted ? { field: "recorded", value: o.recorded, quote: recordedText, mustHold: true } : { field: "recorded", value: o.recorded, quote: recordedText },
      { field: "instrument", value: o.docNo, quote: `Document No. ${o.docNo}` },
      { field: "amount", value: o.amount, quote: `amount of ${money(o.amount)}` },
      { field: "holder", value: o.beneficiary, quote: `Beneficiary: ${o.beneficiary}` },
    ],
  };
}

function taxLien(amountPrinted: string, intended: number, recorded: string, docNo: string): Item {
  const r = `recorded ${longDate(recorded)}`;
  const garbled = amountPrinted !== money(intended);
  return {
    lines: [`A Notice of Federal Tax Lien in the amount of ${amountPrinted}, ${r} as Document No. ${docNo}.`, "Creditor: United States of America (synthetic notice)."],
    fields: [
      { field: "kind", value: "tax-lien", quote: "" },
      { field: "recorded", value: recorded, quote: r },
      { field: "instrument", value: docNo, quote: `Document No. ${docNo}` },
      garbled ? { field: "amount", value: intended, quote: `amount of ${amountPrinted}`, mustHold: true } : { field: "amount", value: intended, quote: `amount of ${amountPrinted}` },
      { field: "holder", value: "United States of America (synthetic notice)", quote: "Creditor: United States of America (synthetic notice)" },
    ],
  };
}

function judgment(amount: number, recorded: string, docNo: string, creditor: string): Item {
  const r = `recorded ${longDate(recorded)}`;
  return {
    lines: [`An Abstract of Judgment in the amount of ${money(amount)}, ${r} as Document No. ${docNo}. Creditor: ${creditor}.`],
    fields: [
      { field: "kind", value: "judgment", quote: "" },
      { field: "recorded", value: recorded, quote: r },
      { field: "instrument", value: docNo, quote: `Document No. ${docNo}` },
      { field: "amount", value: amount, quote: `amount of ${money(amount)}` },
      { field: "holder", value: creditor, quote: `Creditor: ${creditor}` },
    ],
  };
}

function subordination(recorded: string, docNo: string, affecting: string): Item {
  const r = `recorded ${longDate(recorded)}`;
  return {
    lines: [`A Subordination Agreement ${r} as Document No. ${docNo}, by which the Deed of Trust recorded as Document No. ${affecting} is made subordinate.`],
    fields: [
      { field: "kind", value: "subordination", quote: "" },
      { field: "recorded", value: recorded, quote: r },
      { field: "instrument", value: docNo, quote: `Document No. ${docNo}` },
    ],
  };
}

interface Statement {
  readonly id: string;
  readonly line?: boolean;
  readonly date: string;
  readonly original: number;
  readonly balance: number;
  /** Printed in place of the balance. */
  readonly balancePrinted?: string;
}

interface CommitmentSpec {
  readonly doc: string;
  readonly number: string;
  readonly date: string;
  readonly requirements: readonly string[];
  readonly special: readonly Item[];
}

interface FileSpec {
  readonly id: string;
  readonly note: string;
  readonly expect: Generated["expect"];
  readonly commitments: readonly CommitmentSpec[];
  readonly statements: readonly Statement[];
  readonly extra?: readonly { id: string; lines: readonly Line[] }[];
  /** Physical pages that never arrived. */
  readonly missing?: readonly number[];
}

const BASE_REQUIREMENTS = [
  "The Proposed Insured must notify the Company in writing of the name of any party not referred to in this Commitment who will obtain an interest in the Land or who will make a loan on the Land.",
  "Pay the agreed amount for the estate or interest to be insured.",
  "Pay the premiums, fees, and charges for the Policy to the Company.",
  "Documents satisfactory to the Company that convey the Title or create the Mortgage to be insured must be properly authorized, executed, delivered, and recorded in the Public Records.",
];

const FIRST = { amount: 412_000, dated: "2021-02-26", recorded: "2021-03-03", docNo: "2021-0123456", beneficiary: "Quillfeather Home Loans LLC" };
const FIRST_STATEMENT: Statement = { id: "first-statement", date: "2026-10-15", original: 412_000, balance: 371_218.4 };

function commitment(number: string, date: string, requirements: readonly string[] = [], special: readonly Item[] = [easement("1987-06-02", "1987-0042210"), deed(FIRST), ccrs("1986-05-14", "1986-0031177")], doc = "commitment"): CommitmentSpec {
  return { doc, number, date, requirements, special };
}

const SPECS: readonly FileSpec[] = [
  { id: "alta-01", note: "One seasoned first lien, a current statement, every page.", expect: "pass", commitments: [commitment("SYN-B-0101", "2026-10-12")], statements: [FIRST_STATEMENT] },
  {
    id: "alta-02",
    note: "The first lien's recording date prints as merged-edit residue; it must be held, so seasoning can't be told.",
    expect: "unknown",
    commitments: [commitment("SYN-B-0202", "2026-10-12", [], [easement("1987-06-02", "1987-0042210"), deed({ ...FIRST, recordedPrinted: "March 3, 20212022" }), ccrs("1986-05-14", "1986-0031177")])],
    statements: [FIRST_STATEMENT],
  },
  {
    id: "alta-03",
    note: "The statement's balance carries a footnote mark; it must be held, so CLTV stays open.",
    expect: "unknown",
    commitments: [commitment("SYN-B-0303", "2026-10-12")],
    statements: [{ ...FIRST_STATEMENT, balancePrinted: "$371,218.40*" }],
  },
  {
    id: "alta-04",
    note: "Two commitments carry the same Commitment Date, so neither is known to be current.",
    expect: "unknown",
    commitments: [commitment("SYN-B-0404", "2026-10-12"), { ...commitment("SYN-B-0404-R", "2026-10-12"), doc: "commitment-revised" }],
    statements: [FIRST_STATEMENT],
  },
  {
    id: "alta-05",
    note: "A recorded subordination agreement: recording order can't be relied on for position.",
    expect: "unknown",
    commitments: [commitment("SYN-B-0505", "2026-10-12", [], [easement("1987-06-02", "1987-0042210"), deed(FIRST), subordination("2021-04-02", "2021-0140001", "2021-0123456"), ccrs("1986-05-14", "1986-0031177")])],
    statements: [FIRST_STATEMENT],
  },
  {
    id: "alta-06",
    note: "Part I requires a release of an older deed of trust that Part II still lists: until it records, the new line would be third.",
    expect: "fail",
    commitments: [
      commitment(
        "SYN-B-0606",
        "2026-10-12",
        ["Furnish for recordation a full reconveyance of the Deed of Trust recorded as Document No. 2015-0098812, shown as Exception 8 of Part II."],
        [easement("1987-06-02", "1987-0042210"), deed({ amount: 250_000, dated: "2015-05-01", recorded: "2015-05-08", docNo: "2015-0098812", beneficiary: "Larkspur Savings Bank" }), deed(FIRST), ccrs("1986-05-14", "1986-0031177")],
      ),
    ],
    statements: [FIRST_STATEMENT],
  },
  {
    id: "alta-07",
    note: "An open line of credit whose kind is printed on the item's second line.",
    expect: "fail",
    commitments: [
      commitment("SYN-B-0707", "2026-10-12", [], [
        easement("1987-06-02", "1987-0042210"),
        deed(FIRST),
        deed({ amount: 60_000, dated: "2023-07-11", recorded: "2023-07-18", docNo: "2023-0456789", beneficiary: "Bramblecrest Federal Credit Union", line: true }),
        ccrs("1986-05-14", "1986-0031177"),
      ]),
    ],
    statements: [FIRST_STATEMENT, { id: "line-statement", line: true, date: "2026-10-12", original: 60_000, balance: 41_300 }],
  },
  { id: "alta-08", note: "Printed page 3 of 4, the first Part II page, never arrived.", expect: "unknown", commitments: [commitment("SYN-B-0808", "2026-10-12")], statements: [FIRST_STATEMENT], missing: [3] },
  {
    id: "alta-09",
    note: "A federal tax lien whose amount prints two values run together (it must be held) and an abstract of judgment: absence fails either way.",
    expect: "fail",
    commitments: [
      commitment("SYN-B-0909", "2026-10-12", [], [
        easement("1987-06-02", "1987-0042210"),
        deed(FIRST),
        ccrs("1986-05-14", "1986-0031177"),
        taxLien("$9,877.00$10,412.00", 10_412, "2026-02-17", "2026-0019920"),
        judgment(18_240, "2025-11-06", "2025-0283301", "Fixture Supply Company"),
      ]),
    ],
    statements: [FIRST_STATEMENT],
  },
  {
    id: "alta-10",
    note: "Wire instructions travel with the file. They must never reach a model; the title passes.",
    expect: "pass",
    commitments: [commitment("SYN-B-1010", "2026-10-12")],
    statements: [FIRST_STATEMENT],
    extra: [
      {
        id: "closing-instructions",
        lines: [
          HEAD,
          "WIRE TRANSFER INSTRUCTIONS FOR CLOSING FUNDS",
          "Receiving bank: Synthetic Fixture Bank",
          "Routing (ABA): SYN-RT-0042",
          "Account: SYN-ACCT-7781",
          "Beneficiary: Synthetic Escrow Services Trust Account",
          "Reference: CANARY-WIRE-7F3E",
          "Call your escrow officer at a number you already know before you send funds.",
          "Page 1 of 1",
        ],
      },
    ],
  },
  { id: "alta-11", note: "The commitment is 72 days old on the request date; the policy allows 60.", expect: "unknown", commitments: [commitment("SYN-B-1111", "2026-08-20")], statements: [FIRST_STATEMENT] },
  {
    id: "alta-12",
    note: "September's commitment, with a 2016 deed of trust since reconveyed, superseded by October's, which prints its items in another order.",
    expect: "pass",
    commitments: [
      commitment("SYN-B-1212", "2026-09-04", [], [easement("1987-06-02", "1987-0042210"), deed(FIRST), deed({ amount: 250_000, dated: "2016-04-04", recorded: "2016-04-11", docNo: "2016-0110042", beneficiary: "Larkspur Savings Bank" }), ccrs("1986-05-14", "1986-0031177")], "commitment-september"),
      commitment("SYN-B-1212-A", "2026-10-20", [], [ccrs("1986-05-14", "1986-0031177"), deed(FIRST), easement("1987-06-02", "1987-0042210")], "commitment-october"),
    ],
    statements: [FIRST_STATEMENT],
  },
];

interface Page {
  n: number;
  lines: Line[];
}

function build(spec: FileSpec): Generated {
  let n = 0;
  const docs: { id: string; pages: Page[] }[] = [];
  const ideal: Ideal[] = [];
  for (const c of spec.commitments) {
    const total = 4;
    const footer = (i: number) => `Commitment No. ${c.number}    Page ${i} of ${total}`;
    const pages: Page[] = [];
    const scheduleA = { n: ++n, lines: [HEAD, "COMMITMENT FOR TITLE INSURANCE (ALTA 2021 v. 01.00)", `Issued by Synthetic Abstract and Title Co.    Commitment No. ${c.number}`, "SCHEDULE A"] };
    const dateLine = `Commitment Date: ${longDate(c.date)} at 8:00 a.m.`;
    scheduleA.lines.push(
      `1. ${dateLine}`,
      "2. Policy to be issued: ALTA 2021 Loan Policy. Proposed Insured: the lender of the new line of credit.",
      "3. The estate or interest in the Land at the Commitment Date is Fee Simple.",
      "4. The Title is, at the Commitment Date, vested in: Pat Sample and Lee Sample, as joint tenants.",
      "5. The Land is described in Exhibit A, not reproduced in this synthetic file.",
      footer(1),
    );
    pages.push(scheduleA);
    ideal.push({ doc: c.doc, page: scheduleA.n, field: "effective date", value: c.date, quote: `Commitment Date: ${longDate(c.date)}` });
    const requirements = [...BASE_REQUIREMENTS, ...c.requirements];
    pages.push({ n: ++n, lines: [`Commitment No. ${c.number}    SCHEDULE B, PART I - REQUIREMENTS`, "All of the following Requirements must be met:", ...requirements.map((r, i) => `${i + 1}. ${r}`), footer(2)] });
    const exceptions = [...STANDARD, TAXES, ...c.special];
    const split = 6;
    const partII = (from: number, to: number, continued: boolean): Page => {
      const page: Page = { n: ++n, lines: [`Commitment No. ${c.number}    SCHEDULE B, PART II - EXCEPTIONS${continued ? " (continued)" : ""}`] };
      for (let i = from; i < to; i += 1) {
        const item = exceptions[i]!;
        const number = i + 1;
        const lines = item.lines.map((l, j) => (j === 0 ? `${number}. ${l}` : `   ${l}`));
        page.lines.push(...lines);
        for (const f of item.fields) {
          const quote = f.field === "kind" ? lines.map((l) => l.trim()).join(" ") : f.quote;
          ideal.push({ ...f, doc: c.doc, page: page.n, field: `item ${number} ${f.field}`, quote });
        }
      }
      return page;
    };
    pages.push(partII(0, split, false));
    const last = partII(split, exceptions.length, true);
    last.lines.push("END OF SCHEDULE B, PART II", "This page is only a part of a 2021 ALTA Commitment for Title Insurance (synthetic).");
    pages.push(last);
    pages[2]!.lines.push(footer(3));
    last.lines.push(footer(4));
    docs.push({ id: c.doc, pages });
  }
  for (const s of spec.statements) {
    const page: Page = { n: ++n, lines: [] };
    const date = `Statement Date: ${slashDate(s.date)}`;
    const original = s.line ? `Credit Limit: ${money(s.original)}` : `Original Principal: ${money(s.original)}`;
    const balance = `${s.line ? "Principal Balance" : "Outstanding Principal Balance"}: ${s.balancePrinted ?? money(s.balance)}`;
    page.lines.push(HEAD, s.line ? "LINE OF CREDIT STATEMENT" : "MONTHLY MORTGAGE STATEMENT", `Servicer: ${s.line ? "Bramblecrest Federal Credit Union" : "Quillfeather Home Loans LLC"}`, date, original, balance, "Page 1 of 1");
    docs.push({ id: s.id, pages: [page] });
    ideal.push({ doc: s.id, page: page.n, field: "statement date", value: s.date, quote: date });
    ideal.push({ doc: s.id, page: page.n, field: "original principal", value: s.original, quote: original });
    ideal.push(s.balancePrinted ? { doc: s.id, page: page.n, field: "principal balance", value: s.balance, quote: balance, mustHold: true } : { doc: s.id, page: page.n, field: "principal balance", value: s.balance, quote: balance });
  }
  for (const e of spec.extra ?? []) docs.push({ id: e.id, pages: [{ n: ++n, lines: [...e.lines] }] });
  const newest = [...spec.commitments].sort((a, b) => (a.date < b.date ? 1 : -1));
  const current = newest.length > 1 && newest[0]!.date === newest[1]!.date ? null : (newest[0]?.doc ?? null);
  const missing = new Set(spec.missing ?? []);
  const kept = docs.map((d) => ({ ...d, pages: d.pages.filter((p) => !missing.has(p.n)) })).filter((d) => d.pages.length > 0);
  return {
    id: spec.id,
    note: spec.note,
    expect: spec.expect,
    current,
    json: {
      id: spec.id,
      synthetic: true,
      layout: "alta-2021-commitment",
      note: spec.note,
      request: { asOf: "2026-10-31", homeValue: { lo: 700000, hi: 700000 }, amount: { lo: 100000, hi: 100000 }, maxCltv: 80 },
      docs: kept,
    },
    ideal: ideal.filter((i) => !missing.has(i.page)),
  };
}

export function layoutB(): Generated[] {
  return SPECS.map(build);
}

/**
 * The key a reader is scored against: each field's value, or null where it must be held. Schedule B
 * items are keyed only on the current commitment, the only one whose items a check reads.
 */
export function keyOf(files: readonly Generated[]): Record<string, { expect: Generated["expect"]; fields: Record<string, string | number | null> }> {
  return Object.fromEntries(
    files.map((f) => [
      f.id,
      {
        expect: f.expect,
        fields: Object.fromEntries(f.ideal.filter((i) => !i.field.startsWith("item ") || i.doc === f.current).map((i) => [`${i.doc}|${i.field}`, i.mustHold ? null : i.value])),
      },
    ]),
  );
}

export const OUT = fileURLToPath(new URL("../examples/title-b/", import.meta.url));

export function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  const files = layoutB();
  mkdirSync(OUT, { recursive: true });
  for (const f of files) writeFileSync(join(OUT, `${f.id}.json`), render(f.json));
  writeFileSync(
    join(OUT, "key.json"),
    render({
      keyedBy: "scripts/layout-b.ts (the generator that wrote the files; not an outside keyer)",
      note: "file -> doc|field -> the value printed, or null where the printed text can't be read as one value and must come back held",
      files: keyOf(files),
    }),
  );
  console.log(`wrote ${files.length} files and key.json to ${OUT}`);
}
