-- Add Shopify support to the OntologyFunction cache so the Shopify agent can
-- persist its question-hash → ShopifyQL cache the same way DIA persists its
-- SQL cache.
--
-- Both ALTER TYPE statements are additive (no data backfill required).
-- Existing OntologyFunction rows keep their current kind/sourceType values.

ALTER TYPE "OntologyFunctionKind" ADD VALUE IF NOT EXISTS 'SHOPIFY_API';
ALTER TYPE "OntologyFunctionSourceType" ADD VALUE IF NOT EXISTS 'SHOPIFY';
