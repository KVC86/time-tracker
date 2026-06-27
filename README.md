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
│   └── seed.ts              # seeds a test org + agent + team lead
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
npm run seed                          # test org + employee (prints login IDs)
npm run start:dev                     # http://localhost:3000
```

Then follow [`RUN-LOCALLY.md`](RUN-LOCALLY.md) §8 to watch the break, overrun, and shift-expiry rules fire, and [`RUN-AUTH.md`](RUN-AUTH.md) to exercise the password → MFA login flows.

## Scripts

| Command | Description |
|---|---|
| `npm run start:dev` | Start the API + enforcement worker in watch mode |
| `npm run build` / `npm start` | Build to `dist/` and run |
| `npm run seed` | Seed a test organization, agent, and team lead |
| `npm test` | Run the Jest suite |

## CI/CD & deployment

Every push and PR runs the **CI** pipeline ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): it spins up Postgres + Redis, installs, runs migrations and the partial-index SQL, seeds, builds, and runs the test suite. On a green push to `main` it then builds a Docker image and publishes it to **GitHub Container Registry (GHCR)** at `ghcr.io/kvc86/time-tracker:latest` — so a broken build never produces an image.

The image is self-provisioning: on boot it runs `prisma migrate deploy` and applies `prisma/extra.sql` before starting (see [`docker-entrypoint.sh`](docker-entrypoint.sh)).

**Run the full stack on a server** (needs only Docker):

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env   # required secret
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d     # app + Postgres + Redis on :3000
```

> **Note:** cloning the repo onto a server does **not** auto-deploy it — CI/CD runs on GitHub's runners, triggered by pushes, not by `git clone`. The command above is the one-time manual start. To make pushes redeploy automatically you'd add a deploy step targeting your specific host (VM/PaaS/k8s) on top of the published image.

## Documentation

- [`README-architecture.md`](README-architecture.md) — the scaling decisions, production topology, data model, API surface, and build sequence.
- [`RUN-LOCALLY.md`](RUN-LOCALLY.md) — run it locally and exercise every rule by hand.
- [`RUN-AUTH.md`](RUN-AUTH.md) — apply and test real login + role-based MFA.
