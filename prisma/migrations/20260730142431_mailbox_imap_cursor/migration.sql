-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "imapLastError" TEXT,
ADD COLUMN     "imapLastPolledAt" TIMESTAMP(3),
ADD COLUMN     "imapLastUid" INTEGER;
