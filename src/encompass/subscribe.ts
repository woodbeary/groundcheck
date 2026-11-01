/**
 * The connector's Encompass webhook subscription. It asks for exponential delivery, which retries
 * for 8 hours, instead of the default three linear tries 20 seconds apart before an event is
 * discarded (reference/wbhks-retry-logic), and it brings its own signing key, which must meet
 * ICE's complexity rule (reference/subscriptions; the expression is from Partner Connect's
 * webhook docs). Lock and unlock events are not subscribed: since the desktop shared lock (26.1)
 * they stop arriving for desktop users.
 */

export const SIGNING_KEY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$^&*])([A-Za-z0-9!@#$^&*]){32,64}$/;

export const EVENTS = ["attachment", "document", "enhancedfieldchange"] as const;

export function subscriptionBody(endpoint: string, signingKey: string, events: readonly string[] = EVENTS) {
  if (!endpoint.startsWith("https://")) throw new Error("the webhook endpoint must be HTTPS");
  if (!SIGNING_KEY.test(signingKey)) throw new Error("the signing key must be 32 to 64 characters with an upper and a lower case letter, a digit and one of ! @ # $ ^ & *, and no spaces");
  if (events.some((e) => e === "lock" || e === "unlock")) throw new Error("lock and unlock events stop arriving for desktop users under the shared lock; don't build on them");
  return { endpoint, resource: "Loan", events: [...events], deliveryPolicy: { backoff: "exponential" as const }, signingkey: signingKey };
}
