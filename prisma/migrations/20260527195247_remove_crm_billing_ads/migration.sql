/*
  Warnings:

  - You are about to drop the `Ads` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Billing` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Crm` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Ads" DROP CONSTRAINT "Ads_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Ads" DROP CONSTRAINT "Ads_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Billing" DROP CONSTRAINT "Billing_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Billing" DROP CONSTRAINT "Billing_organisationId_fkey";

-- DropForeignKey
ALTER TABLE "Crm" DROP CONSTRAINT "Crm_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Crm" DROP CONSTRAINT "Crm_organisationId_fkey";

-- DropTable
DROP TABLE "Ads";

-- DropTable
DROP TABLE "Billing";

-- DropTable
DROP TABLE "Crm";
