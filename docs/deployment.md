# Deployment

## Two modes, and only one of them works today

`DEPLOY_MODE` is required and has no default, because the safe default and the
useful default are different modes and guessing either is wrong.

### `demo`

Synthetic data, header-based actor identification, nothing persisted. Safe to
expose to a reviewer — a lawyer, a gemeente contact, a prospective worker —
because it cannot hold real people's data: the store is in-memory and dies with
the process.

Every response carries `x-deliverho-mode: demo` and a warning header, and
`/health` says the same in its body. An instance's mode is never in doubt.

Demo mode **refuses to start if handed production configuration**
(`DATABASE_URL`, `AUTH_PROVIDER_URL`, `OPERATOR_VERGUNNING`). A demo quietly
accumulating real data is the failure this guards against.

```bash
export DEPLOY_MODE=demo
export PSEUDONYM_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm ci && npm run build && npm start
```

### `live`

**Live mode cannot currently boot**, and that is the honest state of the
system rather than an oversight. It refuses with the list of what is missing:

| Variable | Missing thing | Why it blocks |
|---|---|---|
| `AUTH_PROVIDER_URL` | Real authentication | The API identifies actors from an `x-actor-id` header. In live mode that lets anyone accept bookings as any worker. Threat model T6. |
| `DATABASE_URL` | Postgres | The store is in-memory. Bookings and the municipal administration must survive a restart. See `db/schema.sql`. |
| `OPERATOR_VERGUNNING` | The licence number | Operating an escortbedrijf without one is an offence, and the number must appear in every advertisement. Functional design §1. |

Setting all three makes the process start. **It does not make the system
ready.** The variables check shape, not readiness — see the pre-live checklist
below.

## Container

```bash
docker build -t deliverho .
docker run --rm -p 3000:3000 \
  -e DEPLOY_MODE=demo \
  -e PSEUDONYM_KEY="$(openssl rand -hex 32)" \
  deliverho
```

Multi-stage; runs as the unprivileged `node` user; dev dependencies pruned from
the runtime layer. `HEALTHCHECK` hits `/health`.

Behind a load balancer, set `TRUST_PROXY=1` — but only where a proxy really
terminates, since it makes `X-Forwarded-For` authoritative for rate limiting.

## What is hardened, and what is not

Present:

- **Helmet** with a locked-down CSP, `no-referrer`, and frame denial.
- **Rate limiting**, 120/min, keyed on actor where one is presented and IP
  otherwise.
- **Redacted logging.** Requests are logged by *route pattern* —
  `/bookings/:id/accept`, never the id — and headers, body, query, params and
  URL are dropped before reaching a serialiser. Logs are the classic leak path
  for exactly the data this platform protects: a log aggregator has far weaker
  access controls than the database, and entries persist there.
- **Graceful shutdown** on SIGTERM/SIGINT. An open safety session outlasting a
  deploy matters more than an in-flight booking transition.

Absent, and load-bearing:

- **Real authentication.** The single largest gap.
- **Persistence.** `db/schema.sql` is written; no repository implementation
  targets it yet.
- **TLS.** Terminate upstream. Never serve this over plaintext.
- **Backups, and a tested restore.** Untested backups are not backups.
- **Per-endpoint rate limits** on verification and booking routes, which are
  the ones worth enumerating against.

## Before a live deployment

Technical readiness is the smaller half of this list.

- [ ] **Vergunning obtained.** Without it, running the live service is the
      offence, not a compliance gap. Functional design §1.
- [ ] Municipal rule sets verified by a Dutch lawyer. `grep -r UNVERIFIED src/`
      returns nothing.
- [ ] Real authentication replacing the header placeholder.
- [ ] Postgres, with the append-only grant on `booking_events` actually applied
      — the application role gets INSERT and SELECT, never UPDATE or DELETE.
- [ ] `PSEUDONYM_KEY` in a secret manager, not an env file, and a rotation plan.
      Rotating it breaks the link between old administration records and
      workers, which is the point, but means old records can no longer be
      re-attributed. Decide that consciously.
- [ ] DPIA completed, DPO appointed.
- [ ] Escalation ladder staffed for the hours bookings are accepted. A safety
      session nobody answers is worse than none — it is a promise made.
- [ ] Penetration test.
- [ ] Retention automated. Retention that depends on someone remembering does
      not happen.

## Where to host

Not yet decided. Two constraints worth carrying into that decision:

- **Keep the data in the EU**, with a processor agreement that says so. This is
  AVG Article 9 data and a US-hosted control plane invites questions you will
  not enjoy answering to a gemeente.
- **Check the provider's acceptable-use policy before committing.** Several
  mainstream hosts and most payment processors decline this sector outright.
  Finding that out after building the deployment pipeline is expensive.
