# Operating lawfully in the Netherlands

**This is an engineering document, not legal advice.** It records the
assumptions the code makes so a Dutch lawyer can check them. Where the code
encodes a rule, the rule is named here with the file that enforces it.

## What makes this lawful and what would stop it being so

Sex work is legal in the Netherlands. Operating a business that arranges it —
an *escortbedrijf* — is legal **with a municipal licence** (*vergunning*) and
a criminal offence without one. Two further things stay criminal regardless of
any licence:

- **Article 273f Sr — mensenhandel.** Profiting from someone else's sex work
  where coercion, deception, abuse of a vulnerable position, or control over
  their earnings is present. A vergunning is not a defence.
- **Facilitating work by someone under the minimum age**, or by someone with no
  right to work in the Netherlands.

Everything in `src/policy/` and `src/risk/` exists to keep the platform on the
right side of those two, not merely of the licensing rules.

## Rules the code enforces

| Rule | Where | Failure mode if removed |
|---|---|---|
| Operator holds a currently valid, unsuspended vergunning | `policy/eligibility.ts` → `checkOperator` | Operating without a licence |
| Worker meets the municipal minimum age | `policy/eligibility.ts` → `checkWorker` | Facilitating underage work |
| Worker's right to work in NL confirmed | same | Facilitating illegal employment |
| Intake interview held, **with the worker alone** | same | The one check that detects a third party speaking for the worker |
| Worker informed of exit programmes | same | Municipal condition in most APVs |
| Unconfigured gemeente refuses all bookings | `policy/screening.ts` | Trading where we have not read the APV |
| Vergunning number available for every advertisement | `Operator.vergunningNumber` | APV advertising condition |
| Booking administration retained and producible | `privacy/retention.ts` | Cannot answer an inspection |

## The municipal layer

Licensing conditions are set per gemeente in the APV, not nationally. They
differ in ways that change behaviour — most visibly the minimum working age,
which is 18 nationally but **21 under many municipal APVs**, including
Amsterdam, Rotterdam and Utrecht.

`policy/municipality.ts` therefore holds a rule set per gemeente and
**fails closed**: a municipality with no configured rules refuses every booking
rather than falling back to a default. `STRICT_DEFAULTS` is the strictest
common denominator.

The seeded entries in `developmentRegistry()` are marked `UNVERIFIED` in their
`sourceReference` field. **Before operating in any gemeente**, someone
qualified must check that rule set against that gemeente's current APV and
replace the reference with the article actually relied on. A grep for
`UNVERIFIED` should return nothing in a production configuration.

## Pending legislation

The **Wet regulering sekswerk (Wrs)** has been before parliament since 2019/2020
and, if enacted in something like its introduced form, would set a national
minimum age of 21 and introduce a national licence for sex workers themselves,
alongside the operator licence. That would add a per-worker licence check to
`checkWorker`. The code is shaped for it — worker eligibility is already a
list of independent gates — but the check is not written, because the
requirement does not yet exist and its final form is unknown.

Check the current status of the Wrs before relying on anything in this
paragraph; it is the part of this document most likely to have gone stale.

## What this platform deliberately does not do

Each of these is a decision, not an omission:

- **No auto-assignment or dispatch.** A booking becomes work when a named
  person accepts it. There is no operator-side accept command in the domain,
  and `tests/booking.test.ts` fails if one is added.
- **No cancellation penalties.** A financial penalty for withdrawing is a
  coercion mechanism. There is no penalty field anywhere in `domain/booking.ts`.
- **No health or STI data.** Mandatory testing is not lawful to impose, the data
  is AVG Article 9, and holding it creates leverage over the worker. If a client
  asks, the answer is that we do not hold it.
- **No worker location tracking between bookings.** Safety sessions cover the
  booking window. Continuous tracking is surveillance with a safety label on it.
- **No client reviews or ratings of workers.** Public rating of a person's
  sexual services is a pressure mechanism with no upside for the worker.

## Before going live

1. Obtain the vergunning. The platform is not the licensable thing — the
   business is — and no amount of code substitutes for it.
2. Have a Dutch lawyer review the rule sets in `policy/municipality.ts`
   against each gemeente's current APV.
3. Register the processing with a DPO and complete a DPIA. An AVG Article 9
   processing operation at this scale requires one; see
   `docs/data-protection.md`.
4. Replace the placeholder authentication in `api/server.ts`. It trusts a
   header, which in production would let anyone act as any worker.
5. Agree the escalation ladder with the people on it, including whether and
   when police are contacted. Sex workers' relationship with police is not
   uniformly good, and an escalation that a worker does not want is a reason
   for them not to open a session at all.
