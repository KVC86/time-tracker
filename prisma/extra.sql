-- Run AFTER `prisma migrate dev` (see RUN-LOCALLY.md step 5).
-- Prisma maps fields to camelCase columns, so identifiers are quoted.

-- One OPEN shift per employee → makes clock-in idempotent (no double clock-in).
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_open_per_employee
  ON time_entries ("employeeId")
  WHERE status = 'OPEN';

-- Fast reconciliation sweep: open breaks past their deadline.
CREATE INDEX IF NOT EXISTS break_entries_open_overdue
  ON break_entries ("deadlineAt")
  WHERE "endedAt" IS NULL;
