#!/bin/sh
# Container startup: bring the database schema up to date, then start the app.
# Runs every boot; all steps are idempotent and safe to repeat.
set -e

echo "==> Applying database migrations (prisma migrate deploy)"
npx prisma migrate deploy

echo "==> Applying partial indexes (prisma/extra.sql)"
npx prisma db execute --schema prisma/schema.prisma --file prisma/extra.sql

echo "==> Starting Time Tracker API"
exec node dist/main.js
