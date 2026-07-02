-- Rename the LeaveType enum value UNPAID -> BIRTHDAY.
-- Postgres updates every existing row that uses the value in place, so no
-- leave-request data is lost and no other enum value is affected.
ALTER TYPE "LeaveType" RENAME VALUE 'UNPAID' TO 'BIRTHDAY';
