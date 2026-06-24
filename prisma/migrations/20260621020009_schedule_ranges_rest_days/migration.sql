-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "isRestDay" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "scheduledStart" DROP NOT NULL,
ALTER COLUMN "scheduledEnd" DROP NOT NULL;
