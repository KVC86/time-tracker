# Run the Time Tracker locally

This gets the module running on your machine with a real PostgreSQL + Redis, a dev auth stub, and a seeded test employee — so you can exercise every rule by hand.

> **Heads up:** the six module files (`schema.prisma`, the four `src/time-tracking/*.ts`) are the real thing. The rest (`main.ts`, `app.module.ts`, `prisma.service.ts`, the `auth/*` stubs, `seed.ts`, Docker, configs) is **local-dev scaffolding** so you can test before building real auth. The `auth/*` files are deliberately fake — they trust a header instead of a JWT. Replace them before any deployment.

---

## 0. What to install first

| Tool | Why | Get it |
|---|---|---|
| **Node.js 24 LTS** | runs the app | https://nodejs.org (pick the 24 LTS installer) |
| **Docker Desktop** | runs Postgres + Redis without installing them natively | https://www.docker.com/products/docker-desktop |
| **A terminal + curl** | sending test requests | built into macOS/Linux; on Windows use PowerShell or Git Bash |

Verify Node:
```bash
node -v   # should print v24.x
```

---

## 1. Put the files in one folder

Create a folder (e.g. `wfm-time-tracker`) and place everything under it preserving this layout:

```
wfm-time-tracker/
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── nest-cli.json
├── .env.example
├── prisma/
│   ├── schema.prisma
│   ├── extra.sql
│   └── seed.ts
└── src/
    ├── main.ts
    ├── app.module.ts
    ├── prisma/prisma.service.ts
    ├── auth/
    │   ├── jwt-auth.guard.ts
    │   ├── roles.guard.ts
    │   └── roles.decorator.ts
    └── time-tracking/
        ├── time-tracking.controller.ts
        ├── time-tracking.service.ts
        ├── break-enforcement.service.ts
        └── time-tracking.gateway.ts
```

---

## 2. Start Postgres + Redis

From the project folder:
```bash
docker compose up -d
docker compose ps        # both containers should show "running"
```

## 3. Configure environment + install dependencies
```bash
cp .env.example .env
npm install
```

## 4. Create the database tables
```bash
npx prisma migrate dev --name init
```
This generates the Prisma client and creates every table from `schema.prisma`.

## 5. Add the partial indexes (the bit Prisma can't express)
```bash
docker compose exec -T postgres psql -U wfm -d wfm < prisma/extra.sql
```

## 6. Seed a test org + employee
```bash
npm run seed
```
Copy the two IDs it prints — you'll paste them into request headers:
```
EMPLOYEE  (x-employee-id): clxxxxEMPLOYEE
TEAM LEAD (x-employee-id): clxxxxTEAMLEAD
```

## 7. Start the app
```bash
npm run start:dev
```
You should see `Time Tracker API running on http://localhost:3000` and a line that the enforcement worker started. Leave this running and open a second terminal for the tests.

---

## 8. Test plan (watch the rules fire)

Set a shell variable so the commands stay short (use your seeded employee id):
```bash
EMP=clxxxxEMPLOYEE
TL=clxxxxTEAMLEAD
```

### A. Clock in
```bash
curl -s -X POST localhost:3000/time/clock-in \
  -H 'content-type: application/json' -H "x-employee-id: $EMP" \
  -d '{"activityType":"Inbound Calls"}'
```
Then check authoritative state:
```bash
curl -s localhost:3000/time/me -H "x-employee-id: $EMP"
```
You'll see `onShift: true`, your `shiftEndsAt`, and the break tallies.

### B. Regular break is locked for the first hour → violation
```bash
curl -s -X POST localhost:3000/time/break/start \
  -H 'content-type: application/json' -H "x-employee-id: $EMP" \
  -d '{"breakType":"REGULAR"}'
```
Expect a 403: *"Regular Break unlocks after 1h..."* — and a `ComplianceViolation` row is written.

### C. Bio break overrun (the scaling mechanism, live)
Start a bio break and **do nothing for 20 seconds**:
```bash
curl -s -X POST localhost:3000/time/break/start \
  -H 'content-type: application/json' -H "x-employee-id: $EMP" \
  -d '{"breakType":"BIO"}'
```
Watch the app terminal. ~20s later the deadline job fires server-side: it ends the overrun break, puts the employee back on their pre-break activity, and records a violation. The shift **stays open** — only the 8-hour expiry (step F) auto-closes a shift. Confirm:
```bash
curl -s localhost:3000/time/me -H "x-employee-id: $EMP"   # onShift: true, back on an activity, bio tally incremented
docker compose exec postgres psql -U wfm -d wfm \
  -c 'select type, detail, "occurredAt" from compliance_violations order by "occurredAt" desc limit 3;'
```
You'll see a `BREAK_OVERRUN` violation — produced entirely server-side by the deadline job, with no browser involved. That's the whole point: enforcement doesn't depend on the client staying connected.

### D. Bio break limit
Clock in again, then take and **end** two bio breaks quickly (within 20s each):
```bash
curl -s -X POST localhost:3000/time/clock-in -H 'content-type: application/json' -H "x-employee-id: $EMP" -d '{"activityType":"Productivity"}'
curl -s -X POST localhost:3000/time/break/start -H 'content-type: application/json' -H "x-employee-id: $EMP" -d '{"breakType":"BIO"}'
curl -s -X POST localhost:3000/time/break/end   -H "x-employee-id: $EMP"
curl -s -X POST localhost:3000/time/break/start -H 'content-type: application/json' -H "x-employee-id: $EMP" -d '{"breakType":"BIO"}'
curl -s -X POST localhost:3000/time/break/end   -H "x-employee-id: $EMP"
# third one is blocked:
curl -s -X POST localhost:3000/time/break/start -H 'content-type: application/json' -H "x-employee-id: $EMP" -d '{"breakType":"BIO"}'
```
The third returns 409 *"Maximum of 2 Bio Breaks reached."*

### E. Additional bio break needs Team Lead approval
Without approval it's refused:
```bash
curl -s -X POST localhost:3000/time/break/start -H 'content-type: application/json' -H "x-employee-id: $EMP" -d '{"breakType":"ADDITIONAL"}'
```
Now grant it **as the Team Lead** (note the role header), then retry as the employee:
```bash
curl -s -X POST localhost:3000/approvals \
  -H 'content-type: application/json' -H "x-employee-id: $TL" -H 'x-roles: TEAM_LEAD' \
  -d "{\"employeeId\":\"$EMP\"}"

curl -s -X POST localhost:3000/time/break/start -H 'content-type: application/json' -H "x-employee-id: $EMP" -d '{"breakType":"ADDITIONAL"}'
```
The second call now succeeds and consumes the approval (a second attempt would be refused again).

### F. 8-hour shift expiry (without waiting 8 hours)
Force the window into the past and let the 30-second reconciliation sweep catch it:
```bash
docker compose exec postgres psql -U wfm -d wfm \
  -c "update time_entries set \"shiftEndsAt\" = now() - interval '1 minute' where status='OPEN';"
```
Within 30s the sweep auto-closes the shift; `GET /time/me` shows `onShift: false` and a `SHIFT_EXPIRED` violation appears.

---

## 9. Resetting between tests
```bash
docker compose exec postgres psql -U wfm -d wfm -c "truncate time_entries, activity_sessions, break_entries, break_approvals, compliance_violations, audit_log cascade;"
```
(Keeps your org/employee/policy; clears the activity.)

To wipe everything and start clean: `docker compose down -v` then redo steps 2–6.

---

## Notes & honest caveats

- **WebSockets:** the real-time gateway is wired in, but its connection handshake requires a JWT signed with `JWT_SECRET`. The REST tests above don't need it — they exercise all the rules and the enforcement engine. When you want to test live push (TL grant → employee event), tell me and I'll add a tiny browser test client + a dev token minter.
- **This is a vetted scaffold, not battle-tested code.** It's written to be correct-by-inspection and to run, but it hasn't been executed end-to-end in CI. If something errors on first run, the most likely culprits are a missing file from step 1 or a Node version mismatch — check those first, then paste me the error.
- **Single process for dev:** the API and the enforcement worker run together here for simplicity. In production they're separate tiers (see the architecture doc §2).
- **Next real milestone:** replace the `auth/*` stubs with a proper auth module (login, JWT issue/verify, refresh, password hashing, roles from the DB). That's the prerequisite before any of this faces real users.
```
