/**
 * Job-title classification, in one place.
 *
 * These patterns decide two different things — how a contact scores, and how a
 * LinkedIn note is worded — and they had drifted into three separate copies:
 * `scoring.ts` and `linkedin/draft.ts` held identical seniority regexes, and
 * `linkedin/queue.ts` a third, narrower one that omitted `owner`, `president`,
 * `cxo` and `partner`. So a founder could score as senior, be drafted a message
 * as senior, and still not carry the "Senior title" reason on their queue card.
 *
 * A title taxonomy is a product decision, not an implementation detail of whoever
 * needs it first. One definition, imported by everyone who classifies a title.
 */

export const SENIOR_TITLE =
  /\b(chief|c[etoi]o|cxo|founder|owner|president|vp|vice[- ]president|head of|director|partner)\b/i

export const MANAGER_TITLE = /\b(manager|lead|principal|senior)\b/i

export const JUNIOR_TITLE = /\b(intern|trainee|apprentice|assistant|junior|jr\.?|graduate|student)\b/i

/** Functions that buy this product, as opposed to merely being senior. */
export const BUYER_FUNCTION =
  /\b(sales|revenue|growth|marketing|demand|bizdev|business development)\b/i
