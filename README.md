# deliverHO

Booking, safety and compliance backend for a **licensed Dutch escortbedrijf**.

Sex work is legal in the Netherlands; operating a business that arranges it
requires a municipal vergunning. This codebase is the software side of running
such a business within those rules — worker-controlled scheduling, licensing
gates, safety cover, and the booking administration a gemeente can inspect.

## What it is not

It is not an on-demand delivery app for people, and the difference is
structural rather than cosmetic:

| Delivery-app model | This |
|---|---|
| System assigns the nearest available worker | Only a named worker can accept, personally |
| Address ships with the job | Address released after acceptance |
| Cancelling costs you | Worker withdraws at any point, no penalty, no reason needed |
| Ratings and acceptance rates discipline workers | Neither exists |
| Speed is the product | Screening is the product |

Those rows are enforced in `src/domain/` and asserted in `tests/`, not left to
the UI. A rule that lives only in the UI is a rule the next endpoint forgets.

## Quick start

```bash
npm install
export PSEUDONYM_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SEED=1 npm run dev          # http://127.0.0.1:3000
npm test                    # 103 tests
npm run typecheck
```

`PSEUDONYM_KEY` is required with no default — see
[docs/data-protection.md](docs/data-protection.md#pseudonyms).

## Layout

```
src/
  domain/      Types and the booking state machine. No I/O, no framework.
  policy/      Municipal rules, eligibility gates, the screening pipeline.
  safety/      Check-in/check-out sessions and escalation.
  risk/        Coercion and trafficking indicators.
  privacy/     Retention, redaction, offboarding.
  services/    Wiring between the store and the domain.
  api/         Fastify routes. Thin: decode, identify, delegate.
  store/       In-memory store behind an interface; db/schema.sql is the
               Postgres shape it mirrors.
```

The domain and policy layers are pure functions over plain data. They know
nothing about Fastify, the database, or the clock — every one of them takes
`now` as an argument, which is why the test suite runs in about a second and
why date-boundary bugs are testable rather than hypothetical.

## The three load-bearing decisions

**1. The worker holds the accept.** There is no operator-side accept command in
the domain, no auto-assign, no dispatch. An unanswered offer expires; it never
decays into an assignment. A worker can withdraw at any point up to and
including `in_progress` — consent to a booking is not consent to the rest of
it — and there is deliberately no cancellation-penalty field anywhere, because
a financial penalty for stopping is a coercion mechanism.

**2. Silence is the alarm.** A safety session opens when the worker departs and
escalates on its own if they do not close it. A worker in trouble may be
watched or unable to reach their phone, so raising the alarm cannot be
something they have to *do*. Only the worker can close a session; the operator
can raise an alarm and never lower one.

**3. Coercion is detectable in ordinary data.** Money converging on one
account, one phone answering for several workers, a worker who never declines.
`src/risk/indicators.ts` looks for exactly these. Signals gate bookings, never
the worker's account, and always route to a named human — cutting off the
income of someone already being controlled pushes them somewhere with no
safeguards at all.

## Before this goes near a real person

Read [docs/compliance-nl.md](docs/compliance-nl.md) and
[docs/threat-model.md](docs/threat-model.md) in full. The short list:

- [ ] **Vergunning obtained.** The business is the licensable thing; no code
      substitutes for it.
- [ ] **Municipal rule sets verified by a Dutch lawyer.** Everything in
      `developmentRegistry()` is marked `UNVERIFIED`; a production config
      should return nothing for `grep -r UNVERIFIED src/`.
- [ ] **Real authentication.** `api/server.ts` trusts an `x-actor-id` header.
      As shipped, anyone could accept bookings as any worker. This is the
      single most dangerous placeholder in the repo.
- [ ] **DPIA completed and a DPO appointed.** AVG Article 9 processing.
- [ ] **Escalation ladder agreed with the people on it**, including whether
      police are contacted at all.
- [ ] **Payment processor confirmed.** Several decline this sector outright;
      find out before building on top.

## A note on the name

"DeliverHO" and the delivery framing will cost you more than they're worth. A
gemeente weighing a vergunning reads your public-facing material, and "hoes"
in it reads as contempt for the people whose consent the whole licence turns
on. App stores and payment processors — the ones that serve this sector at all
— screen on the same signals.

The code doesn't care what you call it; nothing user-facing depends on the
name. But a serious name is close to free, and this one isn't.
