-- Supporting images for Sick/Emergency leave requests, stored as base64 data
-- URLs (same approach as profile/team photos). Additive column with an empty
-- default, so every existing leave_request row and all other behavior is
-- unaffected.
ALTER TABLE "leave_requests" ADD COLUMN "attachments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
