-- CreateEnum
CREATE TYPE "public"."TenantStatus" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "public"."PlanTier" AS ENUM ('internal', 'starter', 'growth', 'scale');

-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('owner', 'admin', 'manager', 'rep');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('invited', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "public"."ContactStatus" AS ENUM ('new', 'working', 'engaged', 'qualified', 'unqualified', 'customer', 'do_not_contact');

-- CreateEnum
CREATE TYPE "public"."EmailVerificationStatus" AS ENUM ('unverified', 'valid', 'risky', 'invalid', 'catch_all');

-- CreateEnum
CREATE TYPE "public"."LeadStatus" AS ENUM ('new', 'contacted', 'qualified', 'converted', 'disqualified');

-- CreateEnum
CREATE TYPE "public"."SequenceStatus" AS ENUM ('draft', 'pending_approval', 'active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "public"."StepType" AS ENUM ('email', 'wait', 'task', 'linkedin_connect', 'linkedin_message', 'linkedin_view', 'call', 'condition');

-- CreateEnum
CREATE TYPE "public"."EnrollmentStatus" AS ENUM ('active', 'paused', 'completed', 'stopped_replied', 'stopped_bounced', 'stopped_unsubscribed', 'stopped_manual', 'failed');

-- CreateEnum
CREATE TYPE "public"."MailboxProvider" AS ENUM ('ses', 'gmail', 'outlook', 'smtp');

-- CreateEnum
CREATE TYPE "public"."MailboxHealth" AS ENUM ('healthy', 'warming', 'throttled', 'blocked', 'disconnected');

-- CreateEnum
CREATE TYPE "public"."EmailDirection" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "public"."EmailStatus" AS ENUM ('queued', 'sending', 'sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced', 'complained', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "public"."SuppressionType" AS ENUM ('email', 'domain');

-- CreateEnum
CREATE TYPE "public"."TaskType" AS ENUM ('call', 'email', 'linkedin', 'follow_up', 'meeting', 'other');

-- CreateEnum
CREATE TYPE "public"."TaskStatus" AS ENUM ('open', 'completed', 'skipped', 'snoozed');

-- CreateEnum
CREATE TYPE "public"."CrmProvider" AS ENUM ('salesforce', 'hubspot', 'pipedrive', 'zoho');

-- CreateEnum
CREATE TYPE "public"."CrmConnectionStatus" AS ENUM ('connected', 'expired', 'error', 'disconnected');

-- CreateEnum
CREATE TYPE "public"."SyncDirection" AS ENUM ('push', 'pull', 'bidirectional', 'none');

-- CreateEnum
CREATE TYPE "public"."AuditAction" AS ENUM ('create', 'update', 'delete', 'login', 'logout', 'invite', 'impersonate', 'connect', 'disconnect', 'export', 'other');

-- CreateTable
CREATE TABLE "public"."tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "public"."TenantStatus" NOT NULL DEFAULT 'active',
    "plan" "public"."PlanTier" NOT NULL DEFAULT 'internal',
    "seatLimit" INTEGER NOT NULL DEFAULT 10,
    "monthlyEmailLimit" INTEGER NOT NULL DEFAULT 50000,
    "enrichCreditLimit" INTEGER NOT NULL DEFAULT 5000,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "public"."UserRole" NOT NULL DEFAULT 'rep',
    "status" "public"."UserStatus" NOT NULL DEFAULT 'invited',
    "passwordHash" TEXT,
    "teamId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "avatarUrl" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."teams" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "managerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."invites" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "public"."UserRole" NOT NULL DEFAULT 'rep',
    "teamId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."api_keys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "industry" TEXT,
    "employeeCount" INTEGER,
    "annualRevenue" BIGINT,
    "country" TEXT,
    "city" TEXT,
    "linkedinUrl" TEXT,
    "websiteUrl" TEXT,
    "description" TEXT,
    "apolloId" TEXT,
    "enrichedAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."contacts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT,
    "emailStatus" "public"."EmailVerificationStatus" NOT NULL DEFAULT 'unverified',
    "firstName" TEXT,
    "lastName" TEXT,
    "title" TEXT,
    "phone" TEXT,
    "linkedinUrl" TEXT,
    "timezone" TEXT,
    "country" TEXT,
    "city" TEXT,
    "accountId" TEXT,
    "status" "public"."ContactStatus" NOT NULL DEFAULT 'new',
    "score" INTEGER NOT NULL DEFAULT 0,
    "apolloId" TEXT,
    "enrichedAt" TIMESTAMP(3),
    "source" TEXT,
    "ownerId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "unsubscribedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "lastRepliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."leads" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "title" TEXT,
    "phone" TEXT,
    "message" TEXT,
    "source" TEXT NOT NULL,
    "sourceMeta" JSONB NOT NULL DEFAULT '{}',
    "status" "public"."LeadStatus" NOT NULL DEFAULT 'new',
    "ownerId" TEXT,
    "convertedContactId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."capture_forms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fieldMap" JSONB NOT NULL DEFAULT '{}',
    "assignRule" JSONB NOT NULL DEFAULT '{}',
    "redirectUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capture_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."contact_lists" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDynamic" BOOLEAN NOT NULL DEFAULT false,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."contact_list_members" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_list_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."score_events" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."custom_field_defs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."email_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "category" TEXT,
    "spamScore" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sequences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "public"."SequenceStatus" NOT NULL DEFAULT 'draft',
    "sendWindowStart" INTEGER NOT NULL DEFAULT 9,
    "sendWindowEnd" INTEGER NOT NULL DEFAULT 17,
    "sendDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "respectHolidays" BOOLEAN NOT NULL DEFAULT true,
    "dailyEnrollCap" INTEGER NOT NULL DEFAULT 200,
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "stopOnAccountReply" BOOLEAN NOT NULL DEFAULT true,
    "trackOpens" BOOLEAN NOT NULL DEFAULT false,
    "trackClicks" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sequence_steps" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "type" "public"."StepType" NOT NULL,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "templateId" TEXT,
    "subject" TEXT,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "taskNote" TEXT,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "variantGroup" TEXT,
    "variantWeight" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sequence_enrollments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "currentStepId" TEXT,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."EnrollmentStatus" NOT NULL DEFAULT 'active',
    "nextRunAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "mailboxId" TEXT,
    "enrolledById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."mailboxes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "public"."MailboxProvider" NOT NULL,
    "email" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "userId" TEXT,
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "health" "public"."MailboxHealth" NOT NULL DEFAULT 'warming',
    "dailyCap" INTEGER NOT NULL DEFAULT 50,
    "warmupDay" INTEGER NOT NULL DEFAULT 0,
    "warmupTarget" INTEGER NOT NULL DEFAULT 200,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "sentTodayOn" TIMESTAMP(3),
    "spfOk" BOOLEAN NOT NULL DEFAULT false,
    "dkimOk" BOOLEAN NOT NULL DEFAULT false,
    "dmarcOk" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckedAt" TIMESTAMP(3),
    "bounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "complaintRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."email_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "direction" "public"."EmailDirection" NOT NULL,
    "status" "public"."EmailStatus" NOT NULL DEFAULT 'queued',
    "contactId" TEXT,
    "mailboxId" TEXT,
    "enrollmentId" TEXT,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "threadKey" TEXT,
    "providerId" TEXT,
    "idempotencyKey" TEXT,
    "opensCount" INTEGER NOT NULL DEFAULT 0,
    "clicksCount" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."email_events" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."suppression_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "public"."SuppressionType" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "public"."TaskType" NOT NULL,
    "status" "public"."TaskStatus" NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "note" TEXT,
    "contactId" TEXT,
    "accountId" TEXT,
    "dealId" TEXT,
    "assigneeId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dueAt" TIMESTAMP(3),
    "snoozedTo" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."pipeline_stages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "isLost" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."deals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stageId" TEXT NOT NULL,
    "accountId" TEXT,
    "contactId" TEXT,
    "ownerId" TEXT,
    "expectedCloseDate" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."activities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "contactId" TEXT,
    "accountId" TEXT,
    "actorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."crm_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "public"."CrmProvider" NOT NULL,
    "status" "public"."CrmConnectionStatus" NOT NULL DEFAULT 'connected',
    "instanceUrl" TEXT,
    "externalId" TEXT,
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."crm_field_mappings" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "localField" TEXT NOT NULL,
    "remoteField" TEXT NOT NULL,
    "direction" "public"."SyncDirection" NOT NULL DEFAULT 'bidirectional',
    "transform" TEXT,
    "transformConfig" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "crm_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."crm_sync_records" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "localHash" TEXT,
    "remoteHash" TEXT,
    "lastPulledAt" TIMESTAMP(3),
    "lastPushedAt" TIMESTAMP(3),
    "conflictAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "crm_sync_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" "public"."AuditAction" NOT NULL DEFAULT 'other',
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."usage_counters" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "public"."tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "public"."tenants"("status");

-- CreateIndex
CREATE INDEX "users_tenantId_role_idx" ON "public"."users"("tenantId", "role");

-- CreateIndex
CREATE INDEX "users_tenantId_teamId_idx" ON "public"."users"("tenantId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "public"."users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "teams_tenantId_name_key" ON "public"."teams"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "public"."sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "public"."sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "public"."sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "invites_tokenHash_key" ON "public"."invites"("tokenHash");

-- CreateIndex
CREATE INDEX "invites_tenantId_email_idx" ON "public"."invites"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "public"."api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_tenantId_idx" ON "public"."api_keys"("tenantId");

-- CreateIndex
CREATE INDEX "accounts_tenantId_name_idx" ON "public"."accounts"("tenantId", "name");

-- CreateIndex
CREATE INDEX "accounts_tenantId_ownerId_idx" ON "public"."accounts"("tenantId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenantId_domain_key" ON "public"."accounts"("tenantId", "domain");

-- CreateIndex
CREATE INDEX "contacts_tenantId_accountId_idx" ON "public"."contacts"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "contacts_tenantId_ownerId_idx" ON "public"."contacts"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "contacts_tenantId_status_idx" ON "public"."contacts"("tenantId", "status");

-- CreateIndex
CREATE INDEX "contacts_tenantId_score_idx" ON "public"."contacts"("tenantId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_tenantId_email_key" ON "public"."contacts"("tenantId", "email");

-- CreateIndex
CREATE INDEX "leads_tenantId_status_idx" ON "public"."leads"("tenantId", "status");

-- CreateIndex
CREATE INDEX "leads_tenantId_email_idx" ON "public"."leads"("tenantId", "email");

-- CreateIndex
CREATE INDEX "leads_tenantId_ownerId_idx" ON "public"."leads"("tenantId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "capture_forms_publicKey_key" ON "public"."capture_forms"("publicKey");

-- CreateIndex
CREATE INDEX "capture_forms_tenantId_idx" ON "public"."capture_forms"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "contact_lists_tenantId_name_key" ON "public"."contact_lists"("tenantId", "name");

-- CreateIndex
CREATE INDEX "contact_list_members_contactId_idx" ON "public"."contact_list_members"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "contact_list_members_listId_contactId_key" ON "public"."contact_list_members"("listId", "contactId");

-- CreateIndex
CREATE INDEX "score_events_contactId_createdAt_idx" ON "public"."score_events"("contactId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_defs_tenantId_object_key_key" ON "public"."custom_field_defs"("tenantId", "object", "key");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_tenantId_name_key" ON "public"."email_templates"("tenantId", "name");

-- CreateIndex
CREATE INDEX "sequences_tenantId_status_idx" ON "public"."sequences"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sequences_tenantId_name_key" ON "public"."sequences"("tenantId", "name");

-- CreateIndex
CREATE INDEX "sequence_steps_sequenceId_idx" ON "public"."sequence_steps"("sequenceId");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_steps_sequenceId_order_variantGroup_key" ON "public"."sequence_steps"("sequenceId", "order", "variantGroup");

-- CreateIndex
CREATE INDEX "sequence_enrollments_tenantId_status_nextRunAt_idx" ON "public"."sequence_enrollments"("tenantId", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "sequence_enrollments_contactId_idx" ON "public"."sequence_enrollments"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_enrollments_sequenceId_contactId_key" ON "public"."sequence_enrollments"("sequenceId", "contactId");

-- CreateIndex
CREATE INDEX "mailboxes_tenantId_health_idx" ON "public"."mailboxes"("tenantId", "health");

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_tenantId_email_key" ON "public"."mailboxes"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_messageId_key" ON "public"."email_messages"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_idempotencyKey_key" ON "public"."email_messages"("idempotencyKey");

-- CreateIndex
CREATE INDEX "email_messages_tenantId_status_idx" ON "public"."email_messages"("tenantId", "status");

-- CreateIndex
CREATE INDEX "email_messages_tenantId_contactId_idx" ON "public"."email_messages"("tenantId", "contactId");

-- CreateIndex
CREATE INDEX "email_messages_threadKey_idx" ON "public"."email_messages"("threadKey");

-- CreateIndex
CREATE INDEX "email_messages_enrollmentId_idx" ON "public"."email_messages"("enrollmentId");

-- CreateIndex
CREATE INDEX "email_events_messageId_type_idx" ON "public"."email_events"("messageId", "type");

-- CreateIndex
CREATE INDEX "suppression_entries_tenantId_idx" ON "public"."suppression_entries"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_entries_tenantId_type_value_key" ON "public"."suppression_entries"("tenantId", "type", "value");

-- CreateIndex
CREATE INDEX "tasks_tenantId_assigneeId_status_dueAt_idx" ON "public"."tasks"("tenantId", "assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_tenantId_type_status_idx" ON "public"."tasks"("tenantId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_tenantId_name_key" ON "public"."pipeline_stages"("tenantId", "name");

-- CreateIndex
CREATE INDEX "deals_tenantId_stageId_idx" ON "public"."deals"("tenantId", "stageId");

-- CreateIndex
CREATE INDEX "deals_tenantId_ownerId_idx" ON "public"."deals"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "activities_tenantId_contactId_occurredAt_idx" ON "public"."activities"("tenantId", "contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "activities_tenantId_accountId_occurredAt_idx" ON "public"."activities"("tenantId", "accountId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "crm_connections_tenantId_provider_key" ON "public"."crm_connections"("tenantId", "provider");

-- CreateIndex
CREATE INDEX "crm_field_mappings_connectionId_object_idx" ON "public"."crm_field_mappings"("connectionId", "object");

-- CreateIndex
CREATE UNIQUE INDEX "crm_field_mappings_connectionId_object_localField_remoteFie_key" ON "public"."crm_field_mappings"("connectionId", "object", "localField", "remoteField");

-- CreateIndex
CREATE INDEX "crm_sync_records_connectionId_object_idx" ON "public"."crm_sync_records"("connectionId", "object");

-- CreateIndex
CREATE UNIQUE INDEX "crm_sync_records_connectionId_object_localId_key" ON "public"."crm_sync_records"("connectionId", "object", "localId");

-- CreateIndex
CREATE UNIQUE INDEX "crm_sync_records_connectionId_object_remoteId_key" ON "public"."crm_sync_records"("connectionId", "object", "remoteId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "public"."audit_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_entity_entityId_idx" ON "public"."audit_logs"("tenantId", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_tenantId_period_metric_key" ON "public"."usage_counters"("tenantId", "period", "metric");

-- AddForeignKey
ALTER TABLE "public"."users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."users" ADD CONSTRAINT "users_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."teams" ADD CONSTRAINT "teams_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."teams" ADD CONSTRAINT "teams_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."invites" ADD CONSTRAINT "invites_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."accounts" ADD CONSTRAINT "accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."accounts" ADD CONSTRAINT "accounts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."contacts" ADD CONSTRAINT "contacts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."contacts" ADD CONSTRAINT "contacts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."contacts" ADD CONSTRAINT "contacts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."leads" ADD CONSTRAINT "leads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."leads" ADD CONSTRAINT "leads_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."capture_forms" ADD CONSTRAINT "capture_forms_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."contact_lists" ADD CONSTRAINT "contact_lists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."contact_list_members" ADD CONSTRAINT "contact_list_members_listId_fkey" FOREIGN KEY ("listId") REFERENCES "public"."contact_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."contact_list_members" ADD CONSTRAINT "contact_list_members_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."score_events" ADD CONSTRAINT "score_events_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."custom_field_defs" ADD CONSTRAINT "custom_field_defs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_templates" ADD CONSTRAINT "email_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sequences" ADD CONSTRAINT "sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sequence_steps" ADD CONSTRAINT "sequence_steps_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "public"."sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sequence_steps" ADD CONSTRAINT "sequence_steps_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "public"."email_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "public"."sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_currentStepId_fkey" FOREIGN KEY ("currentStepId") REFERENCES "public"."sequence_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."mailboxes" ADD CONSTRAINT "mailboxes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."mailboxes" ADD CONSTRAINT "mailboxes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_messages" ADD CONSTRAINT "email_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_messages" ADD CONSTRAINT "email_messages_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_messages" ADD CONSTRAINT "email_messages_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "public"."mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_messages" ADD CONSTRAINT "email_messages_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "public"."sequence_enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."email_events" ADD CONSTRAINT "email_events_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."suppression_entries" ADD CONSTRAINT "suppression_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pipeline_stages" ADD CONSTRAINT "pipeline_stages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "public"."pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."deals" ADD CONSTRAINT "deals_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."activities" ADD CONSTRAINT "activities_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."activities" ADD CONSTRAINT "activities_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."crm_connections" ADD CONSTRAINT "crm_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."crm_field_mappings" ADD CONSTRAINT "crm_field_mappings_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."crm_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."crm_sync_records" ADD CONSTRAINT "crm_sync_records_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."crm_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."usage_counters" ADD CONSTRAINT "usage_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
