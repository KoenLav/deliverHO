# Threat model

Ordered by how much harm the threat does, not by likelihood.

## T1 — A worker is coerced and the platform is the mechanism

**The core threat.** Someone else controls the worker, takes the money, and
uses the platform's efficiency to extract more. This is what turns a lawful
escortbedrijf into a trafficking operation, and it is what Article 273f Sr
prosecutes.

It is also the threat a booking platform is structurally best placed to detect,
because control leaves signatures in ordinary platform data.

**Mitigations** (`src/risk/indicators.ts`):

| Signal | Severity | Reasoning |
|---|---|---|
| `shared_payout_iban` | block | Money not reaching the worker. The strongest single indicator. |
| `shared_contact_number` | block | One person answering for several workers. |
| `worker_phone_is_operator_phone` | block | The worker cannot be reached independently of the operator. |
| `intake_not_alone` | block | The interview that detects a third party was held in front of one. |
| `shared_device` | review | One device running several accounts. |
| `never_declines` | review | Free agents refuse work sometimes. A perfect record over a real sample usually is not the worker's choice. |
| `excessive_consecutive_hours` | review | Debt-driven overwork. |
| `shared_registered_address` | review | Threshold is three, because two people sharing a flat is ordinary. |

The `UNIQUE` constraints on `workers.direct_phone` and `workers.payout_iban` in
`db/schema.sql` restate the two block-severity structural signals at the
database, where a future code path cannot forget them.

**Two deliberate constraints on the response.** Signals gate *bookings*, never
the worker's account; and they route to a named human, never to an automated
action. Cutting off the income of someone already being controlled pushes them
somewhere with no safeguards at all. `tests/risk.test.ts` asserts that
detection mutates no worker record.

**Residual risk: real.** A sophisticated controller gives each worker a
separate phone and IBAN and coaches them to decline occasionally. These signals
raise the cost of that; they do not eliminate it. The intake interview and a
beheerder who knows what they are looking at remain load-bearing, and no
detector replaces them.

## T2 — A worker is assaulted at a booking

**Mitigations** (`src/safety/session.ts`):

The design inverts the usual alarm. A worker in trouble may be watched, unable
to reach their phone, or unable to speak freely — so **the alarm does not
require them to raise it.** A session opens when they depart and escalates on
its own if they do not close it. Silence triggers help; action stands it down.

- A safety session opens in the same call as departure. `depart()` does not
  expose a path to travel without cover, because the one time it matters will
  be the time someone skipped the optional step.
- Departing with no escalation contact is refused outright — an escalation with
  nobody to escalate to is decoration.
- `missed_checkin` catches the worker who departs and never arrives, which
  usually means something went wrong on the way.
- Only the worker can close a session. The operator can raise an alarm and
  never lower one — a coercive operator would otherwise simply close it.
- Extensions are bounded (120 minutes), so an indefinite extension cannot keep
  a session permanently un-escalated.

**Residual risk.** The escalation ladder is only as good as the people on it
and the median response time behind them. Agree it with those people before
launch, including whether police are contacted at all — an escalation a worker
does not want is a reason not to open a session, which costs more than it
gains.

## T3 — The database leaks and outs people

Consequences are permanent and sometimes physically dangerous. See
`docs/data-protection.md` for the full treatment: two-tier retention, externally
keyed pseudonyms, no document scans, no IP addresses, no health data, table-level
separation of identity from bookings.

The design assumption is that the application will be breached, not merely the
disk — which is why minimisation and separation carry the weight rather than
encryption at rest.

## T4 — A client is not who they claim to be

The worker travels to meet a stranger; a false identity removes the only
accountability there is.

- Phone verification is the floor for any booking.
- **iDIN is required for a private residence** — bank-grade identity, because a
  stranger's home is the highest-risk configuration in the system.
- A blocked client is refused at screening, and any worker can block.
- The full address is released only after acceptance. Offers go to several
  workers; if the address travelled with the offer, one request would leak a
  home address to everyone who saw it (`api/serialize.ts`).

## T5 — The operator itself is the adversary

Worth stating plainly: the operator may be the problem, and several mitigations
above are aimed at them rather than at outsiders.

- No operator-side accept command exists in the domain.
- The operator cannot close a safety session.
- `booking_events` is append-only by grant, so the trail cannot be rewritten by
  the party it may be evidence against.
- `worker_phone_is_operator_phone` is a block-severity signal about the
  operator, not the worker.

**Residual risk: substantial.** The operator controls deployment. An operator
willing to edit the code or the database directly defeats all of it. These
measures raise the effort and leave evidence; they do not make the platform
safe against its own owner. That is what the vergunning, inspections and
Article 273f are for.

## T6 — Account takeover

`api/server.ts` currently identifies actors from an `x-actor-kind` /
`x-actor-id` header pair. **This is a placeholder and is marked as one in the
source.** In production it would let anyone act as any worker — accept bookings
in their name, see released addresses, close their safety session.

Before any real deployment: session tokens for workers and operator staff,
short-lived credentials for clients, rate limiting on every route, and
device-binding on worker sessions so a takeover shows up as a
`shared_device` signal.

## Out of scope

- Payment fraud and chargebacks — use a PSP with an explicit policy for this
  sector; several will decline the business outright, which is worth
  establishing before building anything else on top.
- DDoS and general platform availability.
- The physical security of the operator's own premises.
