-- CreateEnum
CREATE TYPE "PayComponentKind" AS ENUM ('ALLOWANCE', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "PayComponentMethod" AS ENUM ('FIXED', 'PERCENT_OF_GROSS', 'BRACKET');

-- CreateEnum
CREATE TYPE "PayComponentScope" AS ENUM ('ORG', 'TEAM', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "PayslipStatus" AS ENUM ('DRAFT', 'RELEASED');

-- CreateEnum
CREATE TYPE "PayslipLineCategory" AS ENUM ('EARNING', 'ALLOWANCE', 'DEDUCTION');

-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "otAcknowledgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "pay_components" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "PayComponentKind" NOT NULL,
    "name" TEXT NOT NULL,
    "method" "PayComponentMethod" NOT NULL DEFAULT 'FIXED',
    "amount" DOUBLE PRECISION,
    "percent" DOUBLE PRECISION,
    "brackets" JSONB,
    "scope" "PayComponentScope" NOT NULL DEFAULT 'ORG',
    "teamId" TEXT,
    "employeeId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "regularHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overtimeHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "nightHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossPay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAllowances" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDeductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "PayslipStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_lines" (
    "id" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "category" "PayslipLineCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'AUTO',
    "componentId" TEXT,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pay_components_orgId_kind_idx" ON "pay_components"("orgId", "kind");

-- CreateIndex
CREATE INDEX "pay_components_teamId_idx" ON "pay_components"("teamId");

-- CreateIndex
CREATE INDEX "pay_components_employeeId_idx" ON "pay_components"("employeeId");

-- CreateIndex
CREATE INDEX "payslips_employeeId_status_idx" ON "payslips"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_employeeId_periodStart_periodEnd_key" ON "payslips"("employeeId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "payslip_lines_payslipId_idx" ON "payslip_lines"("payslipId");

-- AddForeignKey
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "pay_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;
