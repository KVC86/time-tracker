-- Rest-day overtime pay multiplier.
-- Additive column, NOT NULL with a default (PH rest-day OT factor 130% × 130%),
-- so every existing shift policy keeps a sensible rate and payroll for
-- rest-day overtime is paid distinctly from ordinary overtime.
ALTER TABLE "shift_policies" ADD COLUMN "rdOtMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.69;
