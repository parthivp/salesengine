-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "linkedinConnectedAt" TIMESTAMP(3),
ADD COLUMN     "linkedinInvitedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "contacts_tenantId_linkedinInvitedAt_linkedinConnectedAt_idx" ON "contacts"("tenantId", "linkedinInvitedAt", "linkedinConnectedAt");
