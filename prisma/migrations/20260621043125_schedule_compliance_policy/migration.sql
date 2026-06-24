-- AlterTable
ALTER TABLE "shift_policies" ADD COLUMN     "maxConsecutiveDays" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "maxWeeklyHours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "minRestHours" INTEGER NOT NULL DEFAULT 11,
ADD COLUMN     "otWeeklyThresholdHours" INTEGER NOT NULL DEFAULT 40;
