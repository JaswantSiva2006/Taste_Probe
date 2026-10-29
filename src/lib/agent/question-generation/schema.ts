import { z } from "zod";
import { PreferenceResponseSchema } from "@/lib/contracts";

export const ProposalEvidenceSchema = z.object({
  entityId: z.string().min(1).max(200),
  tagIds: z.array(z.string().min(1).max(300)).max(8),
}).strict();

export const ProposedQuestionSchema = z.object({
  proposalId: z.string().min(1).max(100),
  questionText: z.string().min(1).max(240),
  questionType: z.enum(["tag", "entity"]),
  preferenceDimension: z.string().min(1).max(100),
  evidence: z.array(ProposalEvidenceSchema).min(1).max(30),
  targetIds: z.array(z.string().min(1).max(300)).min(1).max(2),
  supportedAnswerTypes: z.array(PreferenceResponseSchema).min(1).max(5),
}).strict();

export const ProposedQuestionBatchSchema = z.object({
  proposals: z.array(ProposedQuestionSchema).max(8),
}).strict();

export type ProposedQuestion = z.infer<typeof ProposedQuestionSchema>;

export const proposedQuestionResponseSchema = {
  type: "OBJECT",
  properties: {
    proposals: {
      type: "ARRAY",
      maxItems: 8,
      items: {
        type: "OBJECT",
        properties: {
          proposalId: { type: "STRING" },
          questionText: { type: "STRING" },
          questionType: { type: "STRING", enum: ["tag", "entity"] },
          preferenceDimension: { type: "STRING" },
          evidence: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                entityId: { type: "STRING" },
                tagIds: { type: "ARRAY", items: { type: "STRING" } },
              },
              required: ["entityId", "tagIds"],
            },
          },
          targetIds: { type: "ARRAY", items: { type: "STRING" } },
          supportedAnswerTypes: {
            type: "ARRAY",
            items: {
              type: "STRING",
              enum: ["like", "dislike", "prefer_a", "prefer_b", "both", "neither", "unknown"],
            },
          },
        },
        required: ["proposalId", "questionText", "questionType", "preferenceDimension", "evidence", "targetIds", "supportedAnswerTypes"],
      },
    },
  },
  required: ["proposals"],
} as const;
