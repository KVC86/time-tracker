-- CreateTable
CREATE TABLE "activity_types" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_types_orgId_idx" ON "activity_types"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_types_orgId_name_key" ON "activity_types"("orgId", "name");

-- AddForeignKey
ALTER TABLE "activity_types" ADD CONSTRAINT "activity_types_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
