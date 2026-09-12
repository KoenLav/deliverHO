# Data protection

## Why this is not a normal privacy document

The fact that a named person does sex work is **AVG Article 9 special-category
data** — it concerns their sex life — and carries the strictest regime in the
regulation. But the regulatory framing understates the actual stakes.

A breach of this database is not a financial event. It outs people to families,
employers, landlords, immigration authorities, custody courts and abusive
ex-partners. Those consequences are permanent and cannot be undone by
notification, compensation, or a year of credit monitoring. Several of them are
physically dangerous.

So the governing question for any schema change here is not *is this lawful to
store* but **what happens to these people if this table leaks**. Encryption at
rest does not answer it: the application is the most likely thing to be
breached, and the application can decrypt.

## The two-tier retention model

The municipal duty to keep a booking administration and the AVG duty of data
minimisation genuinely conflict. The resolution is two tiers on different
clocks (`src/privacy/retention.ts`):

**Tier 1 — administration record.** Date, duration, municipality, vergunning
number, worker pseudonym, status. Kept for the municipal retention period
(default 365 days). Identifies nobody on its own.

**Tier 2 — operational detail.** Addresses, postcodes, requested services,
client identity, free-text notes. Needed to run the booking and to investigate
an incident; needed by nobody 30 days later. Redacted on that clock.

`redactOperationalDetail` keeps the first two digits of the postcode — enough
to locate the booking in a region for the administration, not enough to find
anyone's home.

## Pseudonyms

Administration records carry an HMAC-SHA256 pseudonym rather than a worker id.

A plain hash would be useless here: the worker set at one operator is small, so
anyone holding the id list could re-link every row by brute force in seconds.
The HMAC key lives **outside the database** (`PSEUDONYM_KEY`), so a
database-only breach — by far the most common kind — does not re-identify the
administration.

`main.ts` refuses to start without a key of at least 32 characters. There is no
development default, because development defaults reach production.

## What is deliberately not stored

| Not stored | Why |
|---|---|
| Identity document scans or photographs | We verify, record that we verified, and keep a hash. A stored passport image is a permanent liability with no operational use after the check. |
| Worker legal names outside the verification table | Bookings use a working name. The legal name is needed for the age check and nothing else. |
| IP addresses | `account_accesses` holds a device fingerprint, which is what the shared-device indicator actually needs. An IP additionally reveals where a worker sleeps. |
| Health or STI status | Not lawful to require, Article 9, and creates leverage over the worker. |
| Continuous location | Safety sessions cover the booking window only. |
| Client payment card details | Use a PSP. Never touch the pan. |

## Table-level separation

`worker_identity_verifications` is a separate table from `workers` so ordinary
booking queries never select a date of birth, and so the two can carry
different grants. The same applies to `worker_intake_interviews`, which holds
the interviewer's free-text concerns.

`booking_events` is append-only by grant: the application role holds INSERT and
SELECT, never UPDATE or DELETE. An audit trail an operator can rewrite is not
an audit trail, and the operator is exactly who it may need to be evidence
against.

## Subject access and erasure

A worker exercising access or erasure is never a penalty and never needs the
operator's approval. `planOffboarding` returns what is redacted immediately
(phone, IBAN, boundaries, availability, device fingerprints, escalation
contacts) and what is retained, with the reason and the end date for each.

The retained set is narrow and justified by the municipal duty. Article 17(3)(b)
covers retention required by law, but the justification has to be real and
per-item — which is why the plan states one for each rather than asserting a
blanket exemption.

A worker who cannot leave cleanly is a worker with a reason to stay, and that
is the dynamic this whole system exists to avoid.

## Before processing real data

- Complete a **DPIA**. Article 9 processing at this scale requires one and it
  is not a formality here.
- Appoint a DPO.
- Write the retention schedule down and automate it. Retention that depends on
  someone remembering does not happen.
- Decide, in advance and in writing, what you do when police ask for data
  without a warrant. Deciding this under pressure produces bad answers.
- Penetration-test before launch, not after.
