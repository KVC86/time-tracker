-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "hourlyRate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "shift_policies" ADD COLUMN     "nightDiffPercent" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "otMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.5;
