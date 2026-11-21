export type OrgIdentityFields = {
  displayName?: string;
  legalName?: string;
  industry?: string;
  businessSubType?: string;
  businessKind?: string;
  businessType?: string;
  country?: string;
  city?: string;
  province?: string;
  currency?: string;
  websiteUrl?: string;
  employeeCount?: string;
  foundingYear?: string;
};

export type BusinessContextFields = {
  companyDescription?: string;
  competitors?: string;
  primaryCustomer?: string;
  secondaryCustomer?: string;
  customerSegments?: string;
  businessModel?: string;
  strategicPriorities?: string[];
};

// ─── Result Shapes stored in DB as JSON ──────────────────────────────────────

/**
 * marketOverview column shape:
 * {
 *   summary: string           — 2-3 sentence overview of the market
 *   marketSize: string|null   — e.g. "₹5,000 crore", null if unknown
 *   growthRate: string|null   — e.g. "~15% YoY", null if unknown
 *   keyDynamics: string[]     — top forces shaping the market (3-5 items)
 *   opportunities: string[]   — gaps or openings for a new/small brand
 *   threats: string[]         — headwinds, risks
 *   dominantPlayers: string[] — established market leaders (name only)
 * }
 */
export type MarketOverview = {
  summary: string;
  marketSize: string | null;
  growthRate: string | null;
  keyDynamics: string[];
  opportunities: string[];
  threats: string[];
  dominantPlayers: string[];
};

/**
 * competitors column shape — array of CompetitorProfile:
 * [{
 *   name: string                  — brand name
 *   website: string|null          — homepage URL
 *   estimatedRevenue: string|null — e.g. "~₹50L/year", null if unknown
 *   employeeCount: string|null    — e.g. "10–50", null if unknown
 *   businessModel: string         — "D2C", "Marketplace", "B2B", etc.
 *   targetAudience: string        — who they sell to
 *   priceRange: string|null       — e.g. "₹500–₹2000", null if unknown
 *   keyProducts: string[]         — top product lines or categories
 *   strengths: string[]           — what they do well
 *   weaknesses: string[]          — gaps or criticisms found online
 *   marketPositioning: string     — premium / affordable / niche / etc.
 *   geography: string             — "Pan-India", "Rajasthan", etc.
 *   socialPresence: {
 *     instagram: string|null
 *     facebook: string|null
 *     other: string[]             — other platforms / handles found
 *   }
 *   sources: string[]             — URLs where info was gathered
 *   confidenceScore: number       — 0–1; how much evidence backed this entry
 * }]
 */
export type SocialPresence = {
  instagram: string | null;
  facebook: string | null;
  other: string[];
};

export type CompetitorProfile = {
  name: string;
  website: string | null;
  estimatedRevenue: string | null;
  employeeCount: string | null;
  businessModel: string;
  targetAudience: string;
  priceRange: string | null;
  keyProducts: string[];
  strengths: string[];
  weaknesses: string[];
  marketPositioning: string;
  geography: string;
  socialPresence: SocialPresence;
  sources: string[];
  confidenceScore: number;
};

/**
 * marketTrends column shape:
 * {
 *   trends: [{
 *     name: string
 *     description: string
 *     impact: "HIGH"|"MEDIUM"|"LOW"
 *     isOpportunity: boolean    — true = opportunity, false = threat
 *   }]
 *   seasonality: string|null   — e.g. "Peak Oct–Jan (festive + winter)"
 *   emergingCategories: string[] — new product formats gaining traction
 *   channelShifts: string[]    — e.g. "Instagram Shops growing vs Amazon"
 * }
 */
export type TrendItem = {
  name: string;
  description: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  isOpportunity: boolean;
};

export type MarketTrends = {
  trends: TrendItem[];
  seasonality: string | null;
  emergingCategories: string[];
  channelShifts: string[];
};

/**
 * targetAudience column shape:
 * {
 *   demographics: {
 *     ageRange: string         — e.g. "18–35"
 *     genderSkew: string       — e.g. "Primarily women (80%)"
 *     incomeLevel: string      — e.g. "Lower-middle to middle income"
 *     location: string         — e.g. "Tier 1 & 2 cities, India"
 *   }
 *   behaviors: string[]        — shopping behaviors
 *   preferences: string[]      — product / brand preferences
 *   shoppingChannels: string[] — where they buy (Instagram, Meesho, etc.)
 *   topBrandsTheyBuy: string[] — brands this audience already shops
 *   priceSensitivity: string   — e.g. "High — shops primarily during sales"
 * }
 */
export type AudienceDemographics = {
  ageRange: string;
  genderSkew: string;
  incomeLevel: string;
  location: string;
};

export type TargetAudience = {
  demographics: AudienceDemographics;
  behaviors: string[];
  preferences: string[];
  shoppingChannels: string[];
  topBrandsTheyBuy: string[];
  priceSensitivity: string;
};

/**
 * queryContext column shape — written at job creation for traceability:
 * {
 *   brandName: string
 *   industry: string
 *   subType: string
 *   country: string
 *   scale: string              — derived from employeeCount + foundingYear
 *   searchQueries: string[]    — the exact queries sent to the search model
 *   generatedAt: string        — ISO timestamp
 * }
 */
export type QueryContext = {
  brandName: string;
  industry: string;
  subType: string;
  country: string;
  scale: string;
  searchQueries: string[];
  generatedAt: string;
};

/**
 * sources column shape — array of deduplicated websites:
 * [{ url: string; title: string }]
 */
export type Source = {
  url: string;
  title: string;
};
