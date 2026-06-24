-- CreateTable
CREATE TABLE "activity_assignments" (
    "id" TEXT NOT NULL,
    "activityTypeId" TEXT NOT NULL,
    "employeeId" TEXT,
    "teamId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_assignments_employeeId_idx" ON "activity_assignments"("employeeId");

-- CreateIndex
CREATE INDEX "activity_assignments_teamId_idx" ON "activity_assignments"("teamId");

-- CreateIndex
CREATE INDEX "activity_assignments_activityTypeId_idx" ON "activity_assignments"("activityTypeId");

-- AddForeignKey
ALTER TABLE "activity_assignments" ADD CONSTRAINT "activity_assignments_activityTypeId_fkey" FOREIGN KEY ("activityTypeId") REFERENCES "activity_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_assignments" ADD CONSTRAINT "activity_assignments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_assignments" ADD CONSTRAINT "activity_assignments_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
