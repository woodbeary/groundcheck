/**
 * The Encompass half of dscr-check, end to end on the doc-derived mocks: no credentials, no
 * network, synthetic files only. Run `pnpm demo:encompass`.
 *
 * Live against Encompass: no. Live against Ocrolus: no.
 */

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OVERLAYS } from "../src/dscr/policy.ts";
import { Crash, attachOnce, settleOpen } from "../src/encompass/attach.ts";
import { Ledger } from "../src/encompass/ledger.ts";
import { MockEncompass, type LoanEvent } from "../src/encompass/mock.ts";
import { reconcileLoan } from "../src/encompass/reconcile.ts";
import { ReviewForm, stubElli } from "../src/encompass/ssf.ts";
import { STAGED, stage, stagedValues } from "../src/encompass/staging.ts";
import { subscriptionBody } from "../src/encompass/subscribe.ts";
import { fieldWrites, goldenEntries } from "../src/encompass/writtenby.ts";
import { dscrFromCapture, type BookForms } from "../src/ocrolus/capture.ts";
import { MockOcrolus, UNSUPPORTED_MARK } from "../src/ocrolus/mock.ts";

const LOAN = "loan-synthetic-0101";
const CONNECTOR = "groundcheck-api-user";
const PROCESSOR = "processor-synthetic";
const TARGETS = { [STAGED.leaseRent]: "SYN.SUBJECT.LEASE.RENT" };
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4 synthetic ${text}`);

export async function demo(say: (line: string) => void = console.log): Promise<void> {
  const path = join(tmpdir(), `groundcheck-demo-${process.pid}.db`);
  const enc = new MockEncompass();
  const ocrolus = new MockOcrolus();
  ocrolus.books.push({ uuid: "book-synthetic-0101", name: "Sample SYN-DSCR-0101", loan_guid: LOAN, loan_number: "SYN-DSCR-0101", docs: [] });
  const ledger = new Ledger(path);
  const events: LoanEvent[] = [];
  const sub = subscriptionBody("https://connector.example.invalid/hooks/encompass", "SyntheticSigningKey0123456789!abcdef");
  const subscriptionId = enc.subscribe(sub, (e) => {
    events.push(e);
    return 200;
  });
  const panel = async (now: number) => {
    const h = await reconcileLoan({ api: enc, ocrolus, ledger, listSubscriptions: () => enc.listSubscriptions(), subscriptionId, now, stuckAfterSeconds: 3600 }, LOAN);
    say(`  reconciler: confirmed in eFolder ${h.confirmed} of ${h.expected} · UNKNOWN pages ${h.unknownPages} (to review) · stuck ${h.stuck.length} · health ${h.health.toUpperCase()}`);
    for (const r of h.reasons) say(`    ${r}`);
  };
  try {
    say("Live against Encompass: no. Live against Ocrolus: no. Mocks built from ICE's and Ocrolus's docs, checked 2026-11-01.\n");
    say("1. The file and what Ocrolus did");
    for (const name of ["1007 rent schedule", "lease", "note", "tax bill", "insurance declarations", `blank scan ${UNSUPPORTED_MARK}`]) await attachOnce({ api: enc, ledger, by: CONNECTOR }, LOAN, pdf(name), `${name}.pdf`);
    ocrolus.classify(enc, LOAN, 600, false);
    await panel(700);

    say("\n2. Attach once: a late lease, and the process dies after the PUT");
    const late = pdf("renewed lease");
    await attachOnce({ api: enc, ledger, by: CONNECTOR, crash: (p) => { if (p === "after-put") throw new Crash(p); } }, LOAN, late, "lease-renewal.pdf").catch((e: unknown) => {
      if (!(e instanceof Crash)) throw e;
      say(`  crashed ${e.message}; the ledger row says ${ledger.open()[0]?.state}`);
    });
    for (const o of await settleOpen({ api: enc, ledger, by: CONNECTOR })) say(`  on restart: ${o.state}, ${o.how}; uploads sent ${enc.calls["upload"]}`);
    enc.dropNextPut = true;
    const lied = await attachOnce({ api: enc, ledger, by: CONNECTOR }, LOAN, pdf("second late page"), "addendum.pdf");
    say(`  a PUT answers 200 and keeps nothing: ${lied.state}, ${lied.how}`);

    say("\n3. Health comes from the read path, not from the 200s");
    await panel(800);

    say("\n4. The processor wins");
    const book = (JSON.parse(readFileSync(new URL("../fixtures/ocrolus/book-forms-dscr.json", import.meta.url), "utf8")) as { response: BookForms }).response;
    const report = dscrFromCapture(book, { asOf: "2026-10-31" }, OVERLAYS);
    const values = stagedValues(report);
    say(`  dscr-check on Capture fields: lease rent ${values[STAGED.leaseRent]}, DSCR ${values[STAGED.dscr]}; ${report.overlays.map((o) => `${o.overlay.name} ${o.status.toUpperCase()}`).join(", ")}`);
    await enc.setFields(LOAN, { "SYN.SUBJECT.LEASE.RENT": "3100.00" }, PROCESSOR);
    await stage(enc, LOAN, values, CONNECTOR);
    const form = new ReviewForm(stubElli(enc, LOAN, PROCESSOR), TARGETS);
    const row = (await form.rows())[0]!;
    say(`  SSF form: staged ${row.stagedValue} beside the loan's ${row.currentValue}; nothing overwrote ${row.currentValue}`);
    await form.keep();
    const golden = goldenEntries(events.flatMap(fieldWrites), { "SYN.SUBJECT.LEASE.RENT": { value: values[STAGED.leaseRent]!, source: values[STAGED.source]! } }, CONNECTOR);
    say(`  writtenBy ${golden[0]?.writtenBy}: ${golden[0]?.processorValue} differs from staged ${golden[0]?.staged}, added to the golden set`);

    say("\n5. Missing lease, and honesty");
    const noLease = dscrFromCapture({ ...book, response: { ...book.response, forms: book.response.forms.filter((f) => f.form_type !== "LEASE_AGREEMENT") } }, { asOf: "2026-10-31" }, OVERLAYS);
    say(`  without the lease: DSCR ${stagedValues(noLease)[STAGED.dscr]}, ${noLease.overlays.map((o) => `${o.overlay.name} ${o.status === "unknown" ? "CAN'T TELL" : o.status.toUpperCase()}`).join(", ")}; needs ${noLease.needs[0]}`);
    say("  Live against Encompass: no. A lender's super admin issuing a test-instance key is the step that changes it.");
  } finally {
    ledger.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) await demo();
