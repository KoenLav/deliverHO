# Functional design — v1

Status: **draft for agreement**. Rendered version:
<https://claude.ai/code/artifact/674cb6fa-26ae-4f7c-8d60-3267d6663485>

Nothing here is legal advice. Sections 1, 5 and 6 need review by a Dutch
lawyer before we act on them.

## Agreed

| Question | Decision |
|---|---|
| Customer | Platform for independent workers (no agency in between) |
| Matching | Client browses profiles and requests a **specific** worker |
| Payments | Rate recorded only; money moves directly between the parties |
| v1 surfaces | All three — client web, worker app, back-office |

---

## 1. The licence position — finding

We had been working from the premise that workers would hold licences and the
platform would require them. **That premise does not hold.**

**There is no licence a Dutch sex worker can hold.** Individual registration
was part of the *Wet regulering prostitutie* (Wrp), which failed in the Eerste
Kamer over the privacy objections section 9 deals with. The *Wet regulering
sekswerk* (Wrs) would introduce a *vergunningplicht* for individual sex
workers, but it has been pending since 2019/2020 and is not law.

The licence that exists is the **exploitatievergunning for a seksbedrijf**,
issued by the gemeente under its APV. It licenses the *operator* — whoever
runs the business of advertising and arranging the work.

In the configuration we agreed, **that is us**. We publish profiles of named
workers, take bookings against them, and arrange the meeting. That is
operating an *escortbedrijf* whatever the workers' contractual status. Calling
them independent does not move the licence; it removes the agency that would
otherwise have held it.

Consequences:

- **The vergunning is ours**, in the gemeente where we are established. Bibob
  screening, a named *beheerder*, conditions on advertising and administration.
- **It can be refused.** Some gemeenten run a *maximumstelsel* capping the
  number issued. Settle feasibility before building.
- **Article 273f Sr applies regardless.** A vergunning is not a defence to
  profiting from coerced work. That is why sections 6 and 8 exist.
- **Exposure concentrates rather than disperses.** We are the operator for
  every worker, so intake and verification duties are per-user, not per-roster.

**Before further build:** a Dutch lawyer confirms the operator analysis, and we
hold a pre-application conversation with the target gemeente.

## 2. Actors and surfaces

| Actor | Is | Holds |
|---|---|---|
| Worker | Self-employed (zzp); sets own rate, services, boundaries | No licence — covered by our vergunning |
| Client | Verified individual requesting a specific worker | Phone verification; iDIN for a private residence |
| Beheerder | Our named staff member under the APV | Intake, risk queue, escalation ladder |
| Platform | The *escortbedrijf* — the licensed operator | The vergunning and the administration duty |

Surfaces: **client web** (verify, browse, request), **worker app** (profile,
availability, accept/decline, safety), **back-office** (verification queue,
intake, risk review, administration export).

## 3. Core flows

Because the client requests a *specific* worker, a request goes to one person.
This is better than the spike's broadcast model: no silent competition, and no
request visible to people who were never going to get it.

**Client:** register → verify phone (+ iDIN for private residence) → browse →
request a named worker (time, duration, location, services, published rate) →
screening → worker accepts or declines → client confirms.
An unanswered request **expires; it is never passed to someone else.**

**Worker onboarding:** apply → identity and age verified → right to work
confirmed → **intake interview with the beheerder, alone**, in a language they
speak fluently → exit-programme info given → build profile (worker controls
every published element) → publish availability.

## 4. The consent model — load-bearing

These belong in the domain layer where a later endpoint cannot route around
them.

| Rule | Why |
|---|---|
| Only the requested worker can accept; no reassignment on timeout | Work begins when a named person says yes. Silence is a no. |
| Withdrawal at any point incl. mid-booking; no penalty, no reason | Consent to a booking is not consent to the rest of it |
| Declines never counted publicly, shown to clients, or used in ranking | An acceptance rate that costs visibility is a penalty in disguise |
| Full address released only on acceptance | Before that, gemeente and location type is all that's needed to decide |
| No client ratings or reviews of workers | Public rating of sexual services is pressure with no upside |
| Worker sets rate, services, boundaries; changes at will | Pricing authority is the practical test of independence |
| No completeness scores, streaks, or response-time badges | Engagement mechanics here are pressure applied to whether someone has sex |

## 5. Profiles and advertising

Published profiles follow from the matching model. A profile is two things at
once: an advertisement under the APV, and Article 9 data we are deliberately
making public.

- **Vergunningnummer must appear in every advertisement**, including each
  profile page and any syndicated listing.
- **No profile content to unauthenticated requests**; `noindex` throughout.
- **EXIF stripped on upload**, without exception.
- **Face photos default off**; cropping and obscuring are first-class options,
  never a lesser version of a "complete" profile.
- **Warn explicitly about reverse image search** at upload — a photo used
  anywhere else links the two identities. Most people don't think of this
  unprompted, and it's the most common way workers get outed.
- **Takedown is instant and total** — unpublished, images purged, no grace
  period, no retained copy.

Article 9 publication needs explicit, specific, informed consent that is as
easy to withdraw as to give. The takedown control is prominent and one step —
not behind a warning designed to talk someone out of it.

## 6. Verification and intake — changed

In the agency model the intake interview is the best coercion detector there
is: a trained person talks to the worker alone and notices when someone else is
answering. Choosing "independents" removes the agency, so **the platform runs
the intake itself** or the detector doesn't exist.

| Check | Method | Stored |
|---|---|---|
| Identity and age | iDIN, or in-person document check | Date of birth + document hash. **Never the scan.** |
| Right to work in NL | At verification | Boolean + who confirmed |
| Intake interview | Beheerder, worker alone, video or in person | Date, language, alone-confirmed, concerns |
| Exit programme info | At intake | Boolean + date |

**Over video**, which weakens the "alone" check:

- Interviewer asks the worker to pan the room, and records that they did.
- Conducted in a language the worker speaks **fluently**, not adequately.
- If an interpreter is needed, **we provide them** — never one the worker
  arrives with; that is the person the interview exists to detect.
- An interview that cannot be conducted alone is repeated, not passed with a
  note.

**Re-intake is periodic, not once.** An agency has ongoing contact with its
roster; a platform has none, and control often starts after onboarding.
Cadence is open question Q5.

## 7. Safety sessions

The alarm is inverted: a worker in trouble may be watched, unable to reach
their phone, or unable to speak freely, so raising it cannot be something they
have to *do*.

- A session opens in the same operation as departure — no path to travel
  without cover.
- If the worker doesn't close it by the deadline, **it escalates on its own.**
- A missed check-in catches the worker who departs and never arrives.
- **Only the worker can close a session.** We raise alarms, never lower them.
- Extensions are bounded.
- Departing with no escalation contact is refused.

**This is a staffing commitment, not a feature.** With independents there is no
agency colleague on the other end. A safety session nobody answers is worse
than none — it is a promise we made. See Q3.

## 8. Coercion detection — changed

**This configuration is the highest-risk one available.** A platform of
"independent advertisers" is the shape of the operations prosecuted elsewhere,
because independence is what a controller claims. What separates us is doing
real verification and real intake, which those platforms did not.

"Record the rate only" also costs the strongest structural signal — money
converging on one account. Detection now leans on **account control**: who
actually operates the account.

| Signal | Severity | Reading |
|---|---|---|
| `shared_contact_number` | block | One phone answering for several workers |
| `shared_device` | block | **Upgraded** — now the primary structural indicator |
| `intake_not_alone` | block | The interview that detects a third party was held in front of one |
| `profile_operated_from_other_device` | review | *New.* Rate/boundaries/availability edited from an unusual device |
| `interviewer_recognises_third_party` | review | *New.* Same person at or arranging multiple intakes |
| `never_declines` | review | A perfect record over a real sample usually isn't the worker's choice |
| `boundaries_never_exercised` | review | *New.* Never declined, withdrawn, or adjusted a limit |
| `excessive_consecutive_hours` | review | Debt-driven overwork |
| `shared_registered_address` | review | Threshold three — two sharing a flat is ordinary |

Two constraints on the response:

- **Signals gate bookings, never the account.** Cutting off the income of
  someone already being controlled pushes them somewhere with no safeguards.
- **Every signal routes to a named human.** No automated action, ever.

Residual risk, stated plainly: a controller who issues each worker a separate
phone and device and coaches them to decline occasionally defeats all of this.
These signals raise the cost and leave a trail. The intake interview stays
load-bearing.

## 9. Data and privacy

See [data-protection.md](data-protection.md) for the full treatment. Summary:
two-tier retention (administration vs operational detail, different clocks),
externally-keyed HMAC pseudonyms, and a deliberate not-held list — no document
scans, no health data, no location outside an open session, no IP addresses, no
card details. A DPIA is mandatory and is not a formality at this risk level.

## 10. Out of scope for v1

Payments; ratings and reviews; multiple gemeenten; cross-border.

## 11. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Which gemeente do we establish in? | **Answer first** — sets the APV, the minimum age (18 nationally, 21 under many APVs), and whether a vergunning is obtainable at all |
| Q2 | Profiles visible before client verification? | Verified accounts only; use non-identifying copy for marketing |
| Q3 | Beheerder staffing and hours | Cover the hours we let people book, or restrict bookable hours to the hours we cover |
| Q4 | Police contact during escalation | Worker sets their own ladder at onboarding, including whether police appear on it |
| Q5 | Re-intake cadence | Every six months, rescheduled freely; persistent non-attendance is a risk signal, not an automatic suspension |
| Q6 | Workers who speak neither Dutch nor English? | Yes, with provided interpreters — excluding them doesn't make them safer, it makes them someone else's users |
| Q7 | The name | Change it. Nothing in the build depends on it, and the gemeente reading our material is now our regulator |

## 12. Build sequence

| Phase | Work |
|---|---|
| **P0** | Licence feasibility — lawyer, pre-application meeting. No code. If this fails, nothing downstream matters. |
| **P1** | Back-office — verification queue, intake, risk review, administration export |
| **P2** | Worker app — profile, availability, accept/decline, safety. Ships only once Q3 is answered. |
| **P3** | Client web — verification, browsing, requesting. Last, because it puts profiles in front of strangers. |
| **P4** | Pilot — one gemeente, small invited roster, post-pilot review with the workers on it |

The spike on this branch already implements the consent model, safety sessions,
screening and retention as tested domain code. Roughly two thirds carries into
P1–P2 unchanged; the matching layer and the entire profile surface are new.
