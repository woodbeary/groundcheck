import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTestInstance, refreshOcrolusToken, tokenRequest } from "../src/encompass/auth.ts";
import { ConcurrencyMeter, PerSecondBudget, backoffSeconds } from "../src/encompass/meter.ts";
import { DOC, HttpError, MockEncompass } from "../src/encompass/mock.ts";
import { subscriptionBody } from "../src/encompass/subscribe.ts";
import { MockOcrolus, OCROLUS_DOC } from "../src/ocrolus/mock.ts";

const creds = { clientId: "synthetic-client", clientSecret: "synthetic-secret", user: "groundcheck-api", password: "synthetic-password", instance: "TEBE11111111" };

describe(`authentication [doc: ${DOC}/docs/authentication, checked 2026-11-01]`, () => {
  it("uses the password grant through an API user, with the key as HTTP Basic, and never client_credentials", () => {
    const r = tokenRequest(creds);
    assert.equal(r.url, "https://api.elliemae.com/oauth2/v1/token");
    assert.equal(r.headers.Authorization, `Basic ${Buffer.from("synthetic-client:synthetic-secret").toString("base64")}`);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(r.body)), { grant_type: "password", username: "groundcheck-api@encompass:TEBE11111111", password: "synthetic-password" });
    assert.throws(() => tokenRequest(creds, "client_credentials"), /ISV partners only/);
    assert.equal(isTestInstance("TEBE11111111"), true);
    assert.equal(isTestInstance("BE11111111"), false);
  });

  it(`[${OCROLUS_DOC}/reference/grant-authentication-token] refreshes an Ocrolus token every 12 hours, inside its 24`, () => {
    const t = new MockOcrolus().token(0);
    assert.equal(t.expires_in, 86400);
    assert.equal(refreshOcrolusToken(t.issued_at, 11 * 3600), false);
    assert.equal(refreshOcrolusToken(t.issued_at, 12 * 3600), true);
  });
});

describe(`concurrency [doc: ${DOC}/docs/concurrency-limits, checked 2026-11-01]`, () => {
  it("is a hard stop for everyone: at 30 calls in flight the lender's own staff get 429 too", async () => {
    const enc = new MockEncompass();
    enc.background = 30;
    await assert.rejects(enc.getFields("loan", ["x"]), (e: unknown) => e instanceof HttpError && e.status === 429 && e.headers["X-Concurrency-Limit-Remaining"] === "0");
  });

  it("meters an ISV at 20% and a lender's integration at 80% of the remaining ratio", () => {
    const isv = new ConcurrencyMeter("isv");
    isv.observe({ "X-Concurrency-Limit-Limit": "30", "X-Concurrency-Limit-Remaining": "25" });
    assert.equal(Number(isv.ratio().toFixed(2)), 0.17);
    assert.equal(isv.mayCall(), true);
    isv.observe({ "X-Concurrency-Limit-Limit": "30", "X-Concurrency-Limit-Remaining": "24" });
    assert.equal(isv.mayCall(), false);
    const lender = new ConcurrencyMeter("lender");
    lender.observe({ "X-Concurrency-Limit-Limit": "30", "X-Concurrency-Limit-Remaining": "20" });
    assert.equal(lender.mayCall(), true);
    lender.observe({ "X-Concurrency-Limit-Limit": "30", "X-Concurrency-Limit-Remaining": "6" });
    assert.equal(lender.mayCall(), false);
    lender.observe(new MockEncompass().headers());
    assert.equal(lender.ratio(), 0);
  });

  it("backs off exponentially after a 429", () => {
    assert.deepEqual([1, 2, 3, 4, 8].map(backoffSeconds), [1, 2, 4, 8, 64]);
  });

  it(`[${OCROLUS_DOC}/reference/api-rate-limit-policy] keeps a separate budget of 20 requests a second for Ocrolus`, () => {
    const budget = new PerSecondBudget();
    assert.equal(Array.from({ length: 21 }, () => budget.take(100.2)).filter(Boolean).length, 20);
    assert.equal(budget.take(101), true);
    const o = new MockOcrolus();
    for (let i = 0; i < 20; i += 1) o.token(5);
    assert.throws(() => o.token(5), /20 requests per second/);
  });
});

describe(`the webhook subscription [doc: ${DOC}/reference/wbhks-retry-logic and /reference/subscriptions, checked 2026-11-01]`, () => {
  it("asks for exponential delivery, brings a signing key that meets ICE's rule, and skips lock events", () => {
    const body = subscriptionBody("https://connector.example.invalid/hooks", "SyntheticSigningKey0123456789!abcdef");
    assert.deepEqual(body.deliveryPolicy, { backoff: "exponential" });
    assert.deepEqual(body.events, ["attachment", "document", "enhancedfieldchange"]);
    assert.throws(() => subscriptionBody("http://connector.example.invalid/hooks", "SyntheticSigningKey0123456789!abcdef"), /HTTPS/);
    assert.throws(() => subscriptionBody("https://connector.example.invalid/hooks", "too-short-Key1!"), /32 to 64/);
    assert.throws(() => subscriptionBody("https://connector.example.invalid/hooks", "SyntheticSigningKey0123456789!abcdef", ["lock"]), /desktop users/);
  });
});
