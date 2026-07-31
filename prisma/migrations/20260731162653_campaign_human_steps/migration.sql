-- AlterEnum
ALTER TYPE "EnrollmentStatus" ADD VALUE 'waiting_on_human';

-- AlterTable
ALTER TABLE "sequence_enrollments" ADD COLUMN     "waitingUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "enrollmentId" TEXT;

-- CreateIndex
CREATE INDEX "tasks_enrollmentId_idx" ON "tasks"("enrollmentId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "sequence_enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
