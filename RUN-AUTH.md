# Auth module — apply & test

This adds real login + MFA on top of what you already ran. Sign-in accepts **email or employee code**; MFA is **role-based** — Team Leads/Managers/HR/Payroll/Admins use a **TOTP authenticator app**, floor agents (EMPLOYEE) get a **one-time code by email**.

> The earlier `auth/*` header stub is now replaced by a real JWT guard. After this, the time-tracking endpoints need a real `Authorization: Bearer <token>` instead of the old `x-employee-id` header.

---

## 1. Apply the changes

From the project folder, with Docker already running:

```bash
npm install                              # pulls argon2 + otplib
npx prisma migrate dev --name auth       # creates the new migration
npx prisma migrate reset --force         # clean DB, re-apply, auto-run seed
docker compose exec -T postgres psql -U wfm -d wfm < prisma/extra.sql
npm run start:dev
```

`migrate reset` re-runs the seed automatically, which now prints two logins:

```
AGENT  (email OTP MFA):  john.doe@acme.test  OR  EMP-12
TEAM LEAD (TOTP MFA):    jane.smith@acme.test OR  TL-04
Password for both: Password123!
```

---

## 2. Test the AGENT flow (email OTP)

**Step 1 — password** (try the employee code to prove either identifier works):
```bash
curl -s -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"EMP-12","password":"Password123!"}'
```
Returns `{"status":"MFA_EMAIL_OTP_SENT","mfaToken":"..."}`. Look at the **app terminal** — the dev mailer logged the code:
```
[DEV] Email OTP for john.doe@acme.test: 481920  (expires in 10 min)
```

**Step 2 — the code:**
```bash
curl -s -X POST localhost:3000/auth/mfa/verify \
  -H 'content-type: application/json' \
  -d '{"mfaToken":"PASTE_MFA_TOKEN","code":"481920"}'
```
Returns `accessToken` + `refreshToken`. You're in.

---

## 3. Test the TEAM LEAD flow (TOTP)

**Step 1 — password:**
```bash
curl -s -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"jane.smith@acme.test","password":"Password123!"}'
```
First time, returns `{"status":"MFA_TOTP_ENROLL","mfaToken":"...","otpauthUrl":"otpauth://totp/WFM:jane.smith@acme.test?secret=XXForestofchars&issuer=WFM"}`.

In real life Jane scans that `otpauthUrl` as a QR in Google Authenticator/Authy. To test **without a phone**, pull the `secret=` value out of the URL and compute the current 6-digit code right from the project (otplib is already installed):
```bash
node -e "const {authenticator}=require('otplib'); console.log(authenticator.generate('PASTE_SECRET_FROM_URL'))"
```

**Step 2 — verify** (this also confirms enrollment, so future logins skip the QR):
```bash
curl -s -X POST localhost:3000/auth/mfa/verify \
  -H 'content-type: application/json' \
  -d '{"mfaToken":"PASTE_MFA_TOKEN","code":"123456"}'
```
Returns tokens. (TOTP codes rotate every 30s — if it just ticked over, regenerate and retry.)

---

## 4. Use the token on the time-tracking endpoints

Grab the agent's access token into a shell var, then clock in — note there's **no more `x-employee-id`**; identity comes from the token:
```bash
ACCESS=PASTE_AGENT_ACCESS_TOKEN

curl -s -X POST localhost:3000/time/clock-in \
  -H 'content-type: application/json' -H "Authorization: Bearer $ACCESS" \
  -d '{"activityType":"Inbound Calls"}'

curl -s localhost:3000/time/me -H "Authorization: Bearer $ACCESS"
```
All the break/violation tests from `RUN-LOCALLY.md` §8 work the same way — just swap the `x-employee-id` header for `Authorization: Bearer $ACCESS`. The Team Lead's grant endpoint is now protected by the real role check, so use the **TL's** access token (their `TEAM_LEAD` role lets it through):
```bash
TL_ACCESS=PASTE_TEAMLEAD_ACCESS_TOKEN
curl -s -X POST localhost:3000/approvals \
  -H 'content-type: application/json' -H "Authorization: Bearer $TL_ACCESS" \
  -d "{\"employeeId\":\"PASTE_AGENT_EMPLOYEE_ID\"}"
```

## 5. Refresh & logout
```bash
# rotate (the old refresh token is now dead — that's the security feature):
curl -s -X POST localhost:3000/auth/refresh \
  -H 'content-type: application/json' -d '{"refreshToken":"PASTE_REFRESH"}'

# revoke:
curl -s -X POST localhost:3000/auth/logout \
  -H 'content-type: application/json' -d '{"refreshToken":"PASTE_REFRESH"}'
```

---

## What you have now

- Two-step login (password → MFA), with the factor chosen by role automatically.
- Argon2id password hashing; TOTP secrets enrolled on first staff login; email OTPs hashed, single-use, rate-limited (5 attempts), 10-min TTL.
- Rotating refresh tokens with reuse detection (a stolen-and-replayed token revokes the whole family).
- The WebSocket gateway now verifies the real access token and auto-subscribes a TL to their team's agents (a Manager to their department) — resolved from the DB, so it scales past what a JWT could carry.

## Honest caveats

- **Email delivery is a console stub.** For production, replace the one `deliver()` method in `email-otp.service.ts` with a real transport (nodemailer/SES) — nothing else changes.
- **Multi-tenant login by code:** employee codes are unique per org, so in a single deployment that's fine; if you ever host multiple orgs, scope code lookups by org (e.g. a login subdomain). It's commented in `auth.service.ts`.
- **Still a vetted scaffold, not CI-tested.** If something throws, it's most likely `@node-rs/argon2` failing to install (it ships prebuilt binaries, but on an unusual platform you may need build tools) — tell me your OS and the error and we'll sort it.
- **Production hardening to add later:** per-IP/per-account login rate limiting and lockout, refresh tokens in httpOnly cookies rather than JSON, and audit-logging auth events.
