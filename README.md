# WFM Time Tracker

A server-authoritative **Workforce Management (WFM)** backend built for a BPO/contact-centre setting, designed around a peak load of **~3,000 simultaneously clocked-in employees**, each holding a live WebSocket. The time-tracking module is the foundation; leave, scheduling, and payroll plug into the same employees, schedules, Redis, queues, and audit log.

> **Status:** vetted scaffold for local development. The core rule engine, data model, and enforcement mechanism are written to be correct-by-inspection and to run locally, but the project has not been hardened or exercised end-to-end in CI. Review before relying on it in production. See the caveats in [`RUN-LOCALLY.md`](RUN-LOCALLY.md) and [`RUN-AUTH.md`](RUN-AUTH.md).

## Why it's built this way

Three decisions make the module scale (full rationale in [`README-architecture.md`](README-architecture.md)):

- **Server-authoritative time** — the browser only displays countdowns; every rule ("is the regular break unlocked at 4h?", "did this bio break exceed its limit?", "is the 8-hour shift over?") is computed from timestamps the *server* wrote with `now()`. A client clock can be changed; a server clock can't — non-negotiable once time drives pay.
- **Deadline scheduling, not per-user timers** — instead of 3,000 live `setInterval` timers, each break/shift enqueues a single delayed [BullMQ](https://docs.bullmq.io/) job at its hard deadline. When it fires it checks the DB and auto-logs-out if still overdue; a 30s reconciliation sweep catches anything Redis dropped. This is `O(overdue events)`, not `O(users)`, and survives restarts because the deadline lives in PostgreSQL.
- **Stateless API + shared real-time bus** — API nodes hold no session state (JWT access/refresh; shared state in Redis), so you scale horizontally behind a load balancer. WebSockets fan out via the Socket.IO Redis adapter: a Team Lead's "grant" on any node reaches the target employee's socket on whatever node it's connected to.

## Features

- **Time tracking** — clock-in/out, activity switching, and a full break rule engine (regular-break unlock, bio-break limits, additional-break approvals) enforced entirely server-side.
- **Break enforcement** — overrun and 8-hour-shift expiry handled by delayed jobs + a reconciliation sweep, independent of whether the client stays connected.
- **Auth + MFA** — two-step login (password → MFA) with the factor chosen by role: TOTP authenticator app for staff (TL/Manager/HR/Payroll/Admin), email OTP for floor agents. Argon2id hashing, rotating refresh tokens with reuse detection.
- **Real-time** — Socket.IO gateway with Redis adapter; Team Leads auto-subscribe to their team's agents.
- **Leave** — leave requests with warnings when scheduling over an employee's approved leave.
- **Scheduling, oversight, payroll, admin & profile** — supporting modules that reuse the same data model.
- **Compliance & audit** — first-class `ComplianceViolation` records and an append-only `AuditLog` for every approval, edit, and auto-logout.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime / framework | Node.js 24 LTS · [NestJS 11](https://nestjs.com/) (TypeScript) |
| Database | PostgreSQL via [Prisma 6](https://www.prisma.io/) (PgBouncer in prod) |
| Jobs & real-time | [Redis](https://redis.io/) · [BullMQ](https://docs.bullmq.io/) · [Socket.IO](https://socket.io/) (Redis adapter) |
| Auth | `@nestjs/jwt` · `@node-rs/argon2` · `otplib` (TOTP) |
| Tests | Jest |

## Project layout

```
time-tracker/
├── prisma/
│   ├── schema.prisma        # full data model (orgs, employees, time entries, leave, payroll, audit…)
│   ├── extra.sql            # partial unique / partition migrations Prisma's DSL can't express
│   └── seed.ts              # seeds a test org + a default WFM account
├── src/
│   ├── auth/                # login, MFA (TOTP + email OTP), JWT guards, RBAC
│   ├── time-tracking/       # rule engine, break enforcement, REST controller, Socket.IO gateway
│   ├── leave/ scheduling/ payroll/ oversight/ admin/ profile/
│   └── prisma/              # PrismaService
├── public/                  # thin browser client (employee clock + Team Lead console)
├── docker-compose.yml       # Postgres + Redis for local dev
├── README-architecture.md   # deep dive: scaling decisions, topology, data model, API surface
├── RUN-LOCALLY.md           # step-by-step local run + a test plan that fires every rule
└── RUN-AUTH.md              # apply & test the real auth + MFA flows
```

## Quick start

Requires **Node.js 24 LTS** and **Docker Desktop**. Full walk-through (with a hands-on test plan) is in [`RUN-LOCALLY.md`](RUN-LOCALLY.md).

```bash
docker compose up -d                  # Postgres + Redis
cp .env.example .env
npm install
npx prisma migrate dev --name init    # create tables
docker compose exec -T postgres psql -U wfm -d wfm < prisma/extra.sql   # partial indexes
npm run seed                          # test org + default WFM account (prints login)
npm run start:dev                     # http://localhost:3000
```

Then follow [`RUN-LOCALLY.md`](RUN-LOCALLY.md) §8 to watch the break, overrun, and shift-expiry rules fire, and [`RUN-AUTH.md`](RUN-AUTH.md) to exercise the password → MFA login flows.

**Default seeded login** — `npm run seed` creates one account, a Workforce Management (WFM) user:

```
login:    alex.cruz@acme.test   OR   WFM-01
password: Password123!
MFA:      TOTP authenticator app (WFM is a privileged role)
```

Additional users (agents, team leads, managers) are created from the admin endpoints after signing in as WFM — they are no longer seeded by default.

## Scripts

| Command | Description |
|---|---|
| `npm run start:dev` | Start the API + enforcement worker in watch mode |
| `npm run build` / `npm start` | Build to `dist/` and run |
| `npm run seed` | Seed a test organization + a default WFM account |
| `npm test` | Run the Jest suite |

## Deploy to your own server

Two supported paths. **Docker Compose (Path A) is recommended** — it brings up the app, PostgreSQL, and Redis together, and the app provisions its own database schema on first boot. Path B runs from source if you'd rather not use containers.

> Heads-up: cloning the repo onto a server does **not** start anything by itself, and the CI/CD pipeline does **not** deploy to your server (it runs on GitHub's runners and only publishes a container image). You run one of the paths below once; after that the app stays up via `restart: unless-stopped` (Path A) or your process manager (Path B).

### Prerequisites

| Path | What the server needs |
|---|---|
| **A — Docker** | [Docker Engine](https://docs.docker.com/engine/install/) 24+ with the Compose plugin. That's it — Node, Postgres, and Redis all run in containers. |
| **B — From source** | Node.js 24 LTS, a reachable PostgreSQL 16/17, a reachable Redis 7, and build tools for the native `@node-rs/argon2` binary (`build-essential` on Debian/Ubuntu). |

Open inbound port **3000** (or whatever you set as `PORT`) on the server's firewall/security group. In production, run the app behind a TLS-terminating reverse proxy (nginx/Caddy/your cloud LB) rather than exposing port 3000 directly.

### Path A — Docker Compose (recommended)

**1. Get the files onto the server.** You only need the compose file and an `.env`; the app image is pulled from GHCR. Either clone the repo or copy just `docker-compose.prod.yml`:

```bash
git clone https://github.com/KVC86/time-tracker.git
cd time-tracker
```

**2. Create the `.env` file** (this is the one required secret — the app refuses to start without `JWT_SECRET`):

```bash
cat > .env <<EOF
JWT_SECRET=$(openssl rand -hex 32)     # required: signs access/refresh tokens
POSTGRES_PASSWORD=$(openssl rand -hex 16)  # optional: defaults to "wfm" if unset
WEB_ORIGIN=https://your-frontend.example.com   # optional: CORS origin, defaults to *
EOF
```

| Variable | Required? | Purpose |
|---|---|---|
| `JWT_SECRET` | **Yes** | Signs JWT access/refresh tokens. Use a long random value. |
| `POSTGRES_PASSWORD` | No (default `wfm`) | Password for the bundled Postgres. Set a strong one in production. |
| `WEB_ORIGIN` | No (default `*`) | Allowed CORS origin for the browser client. |

> `DATABASE_URL`, `REDIS_HOST`, etc. are wired automatically inside `docker-compose.prod.yml` to point at the bundled Postgres/Redis services — you don't set them for Path A.

**3. Pull the image and start the stack:**

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

On first boot the app container automatically runs `prisma migrate deploy` and applies the partial indexes from `prisma/extra.sql` (see [`docker-entrypoint.sh`](docker-entrypoint.sh)) — **no manual migration step needed.** The database tables are created for you.

**4. Seed the default WFM account** (one-time, optional — skip if you provision users another way):

```bash
docker compose -f docker-compose.prod.yml exec app npx prisma db seed
```

**5. Verify it's up:**

```bash
docker compose -f docker-compose.prod.yml ps        # all services "running"/"healthy"
docker compose -f docker-compose.prod.yml logs -f app   # look for "Time Tracker API running on ..."
curl http://localhost:3000/                          # the static client is served
```

**Updating to a new release:** `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`. Pending migrations apply automatically on the new container's boot.

### Path B — From source (no containers for the app)

Use this when Postgres and Redis already exist elsewhere (managed DB, separate hosts).

```bash
# 1. Clone and install
git clone https://github.com/KVC86/time-tracker.git
cd time-tracker
npm ci

# 2. Configure environment
cp .env.example .env
#   then edit .env and set, at minimum:
#     DATABASE_URL / DIRECT_DATABASE_URL  -> your Postgres
#     REDIS_HOST / REDIS_PORT             -> your Redis
#     JWT_SECRET                          -> a long random value
#     PORT (default 3000), WEB_ORIGIN (default *)

# 3. Provision the database schema
npx prisma migrate deploy                            # apply all migrations
npx prisma db execute --schema prisma/schema.prisma --file prisma/extra.sql   # partial indexes
npm run seed                                         # optional: default WFM account

# 4. Build and run
npm run build
npm start                                            # node dist/main.js, listens on $PORT
```

For a long-running production process, supervise it with **PM2** (`pm2 start dist/main.js --name time-tracker`) or a **systemd** unit so it restarts on crash/reboot. At higher scale, run the API and the BullMQ enforcement worker as separate tiers — see [`README-architecture.md`](README-architecture.md) §2.

### How CI/CD fits in

Every push and PR runs the pipeline in [`.github/workflows/ci.yml`](.github/workflows/ci.yml): it spins up Postgres + Redis, installs, runs migrations and the partial-index SQL, seeds, builds, and runs the tests. On a **green push to `main`** it builds the Docker image and publishes it to GHCR at `ghcr.io/kvc86/time-tracker:latest` — the exact image Path A pulls. A broken build never produces an image.

This is CI + image publishing, **not** auto-deploy-to-your-server. To make each push redeploy automatically, add a step (e.g. an SSH action that runs the Path A update command on your host, or your PaaS/k8s deploy) on top of the published image — that part is host-specific and intentionally left to you.

## Documentation

- [`README-architecture.md`](README-architecture.md) — the scaling decisions, production topology, data model, API surface, and build sequence.
- [`RUN-LOCALLY.md`](RUN-LOCALLY.md) — run it locally and exercise every rule by hand.
- [`RUN-AUTH.md`](RUN-AUTH.md) — apply and test real login + role-based MFA.
