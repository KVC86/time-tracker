-- Restore the empty-array default on leave_requests.attachments. The column was
-- added with this default, but the schema lacked @default([]) so a later
-- auto-generated migration dropped it, breaking any insert that omits the field.
ALTER TABLE "leave_requests" ALTER COLUMN "attachments" SET DEFAULT ARRAY[]::TEXT[];
