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

## The demo access gate

A demo bound to anything other than loopback **refuses to start without
`DEMO_ACCESS_USER` and `DEMO_ACCESS_PASSWORD`** (minimum 16 characters).

Keying this on the bind address rather than a flag means a container — exposed
by definition — cannot be started ungated by forgetting to set something.
Local development on `HOST=127.0.0.1` stays ungated.

What the curtain is for: the demo presents as an escort booking service run by
a business that does not yet hold a vergunning. It arranges nothing real and
its data is synthetic, but a gemeente official assessing that application
finding it through a search is an avoidable and expensive artefact — and after
functional design §1, that gemeente is our regulator.

`/health` and `/robots.txt` stay open so the platform's own checks work;
neither discloses anything. Demo responses carry
`X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`, and `/robots.txt`
disallows everything.

## Fly.io — the demo instance

`fly.toml` is committed, names the app **`deliverho`**, targets **`ams`
(Amsterdam)**, and contains no secrets.

> `fly launch` regenerates this file and gets two things wrong for this app: it
> defaults `internal_port` to 8080 (we listen on 3000, so the health check would
> fail the deploy) and it strips the comments. If you re-run it, re-check both.

### First time

```bash
fly auth login
fly secrets set \
  PSEUDONYM_KEY="$(openssl rand -hex 32)" \
  DEMO_ACCESS_USER="reviewer" \
  DEMO_ACCESS_PASSWORD="$(openssl rand -base64 24 | tr -d '=+/')"

fly deploy
```

Read the gate password back with `fly secrets list` (digests only) — keep the
value from the command above, or rotate it with another `fly secrets set`.

### Thereafter

```bash
fly deploy                # from a clean working tree
fly logs                  # route patterns only; no ids, ever
fly status
fly apps destroy deliverho          # when the review is done
```

### Via GitHub Actions instead

`.github/workflows/fly-deploy.yml` deploys on **manual dispatch only** —
deliberately not on push, because nothing here should reach a public URL
because someone merged a branch. It typechecks and runs the tests first, and
requires typing `demo` to confirm.

Set `FLY_API_TOKEN` as a repository secret (`fly tokens create deploy` gives a
token scoped to deploying, not to the whole account). This path means the token
never leaves your control.

> **Linking Fly to GitHub does not set this secret.** The Fly Launch
> integration creates the app and pushes a `flyio-new-files` branch; the
> repository secret is a separate, manual step. The workflow checks for it up
> front and says so, because flyctl's own error ("no access token available")
> reads like a tooling problem rather than a missing secret.

### The two sets of secrets are different

Easy to conflate, and each fails at a different point:

| Secret | Lives in | Missing means |
|---|---|---|
| `FLY_API_TOKEN` | GitHub repository secrets | The workflow cannot deploy at all |
| `PSEUDONYM_KEY`, `DEMO_ACCESS_USER`, `DEMO_ACCESS_PASSWORD` | Fly app secrets (`fly secrets set`) | The deploy succeeds, then the app refuses to boot, `/health` never passes, and Fly rolls the release back |

The second failure is the config guard working as designed — an ungated or
unkeyed demo should not start — but it looks like a mysterious health-check
failure if you are not expecting it.

### Notes on the configuration

- **Scales to zero** when idle. The store is in-memory, so a woken demo comes
  back freshly seeded. That suits a demo and reinforces that nothing persists.
- **`TRUST_PROXY=1`** because Fly terminates TLS and forwards the client
  address; without it, rate limiting would key on the proxy and treat every
  visitor as one client.
- **256 MB, shared CPU** is ample for an in-memory demo.
- **Rename the app** before creating it if Q7 (the name) lands first — the URL
  is `<app>.fly.dev` and it is the most visible surface of the naming decision.

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
