import { z } from "zod";

export const REPORT_SECTIONS = ["summary", "value", "features", "issues", "remaining"] as const;
export const ReportSection = z.enum(REPORT_SECTIONS);
export type ReportSection = z.infer<typeof ReportSection>;

export const ClaimDraft = z.object({
  text: z.string().min(1).max(2000),
  evidence_ids: z.array(z.uuid()).max(50),
});
export type ClaimDraft = z.infer<typeof ClaimDraft>;

/** Structured output the LLM must return in the Explain stage (Section 8.6). */
export const ReportDraftSchema = z.object({
  summary: z.array(ClaimDraft).max(20),
  value: z.array(ClaimDraft).max(20),
  features: z.array(ClaimDraft).max(100),
  issues: z.array(ClaimDraft).max(100),
  remaining: z.array(ClaimDraft).max(100),
});
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

export const ClaimDropReason = z.enum([
  "no_evidence",
  "unknown_evidence",
  "foreign_evidence",
  "unsupported_token",
  "number_mismatch",
  "status_contradiction",
  "skipped_check_asserted",
]);
export type ClaimDropReason = z.infer<typeof ClaimDropReason>;

/** The LLM's proposed feature list (Inventory stage); status is set deterministically afterwards. */
export const FeatureProposalSchema = z.object({
  features: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        intent_evidence_ids: z.array(z.uuid()).max(50),
        implementation_evidence_ids: z.array(z.uuid()).max(50),
      }),
    )
    .max(200),
});
export type FeatureProposal = z.infer<typeof FeatureProposalSchema>;
