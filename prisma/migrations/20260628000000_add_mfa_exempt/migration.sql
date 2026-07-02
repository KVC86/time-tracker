-- Experimental per-account MFA exemption.
-- Additive column, NOT NULL with a default of false, so every existing row and
-- every other account's login path is unaffected. Only a row explicitly set to
-- true (the shared demo account) skips the second factor.
ALTER TABLE "users" ADD COLUMN "mfaExempt" BOOLEAN NOT NULL DEFAULT false;
