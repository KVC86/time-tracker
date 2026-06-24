-- Rename ViolationType.BREAK_OVERRUN_AUTO_LOGOUT -> BREAK_OVERRUN.
-- The old name became stale once a break overrun stopped auto-closing the shift
-- (it now ends the break and resumes work; only the 8h expiry closes a shift).
-- ALTER TYPE ... RENAME VALUE preserves existing rows, unlike a drop/add.
ALTER TYPE "ViolationType" RENAME VALUE 'BREAK_OVERRUN_AUTO_LOGOUT' TO 'BREAK_OVERRUN';
