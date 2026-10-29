import { z } from "zod";
import { AgentDecisionSchema, type AgentDecision } from "@/lib/contracts";
import type { AgentDecisionContext } from "./context";
import { offeredQuestions } from "./context";
import { validateAgentDecision } from "./validate";

/**
 * Tool registry. Tools are capabilities granted by application code for one
 * turn: only permitted tools are declared, every ID argument is an enum of
 * server-approved IDs, and every call is re-validated here regardless of what
 * the model was told. Nothing is executed: calls become typed decisions/intents.
 */

export const TOOL_NAMES = ["ask_question", "request_retrieval", "request_enrichment", "finish_discovery"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type RetrievalIntent = {
  kind: "retrieval";
  positiveTagIds: string[];
  positiveEntityIds: string[];
  excludedTagIds: string[];
  excludedEntityIds: string[];
};
export type EnrichmentIntent = { kind: "enrichment"; entityIds: string[] };
export type AgentIntent = RetrievalIntent | EnrichmentIntent;

export type ToolRejection =
  | "unknown_tool"
  | "tool_not_permitted"
  | "invalid_arguments"
  | "unknown_question_id"
  | "unknown_entity_id"
  | "unknown_preference_id"
  | "invalid_decision";

export type ParsedToolCall =
  | { ok: true; tool: ToolName; decision: AgentDecision; intent?: AgentIntent }
  | { ok: false; tool: string; rejection: ToolRejection };

const ids = z.array(z.string().min(1).max(200)).max(20);

const ARG_SCHEMAS = {
  ask_question: z.object({ questionId: z.string().min(1).max(300), reasonCode: z.literal("informative_question") }).strict(),
  request_retrieval: z
    .object({
      reasonCode: z.literal("insufficient_candidates"),
      positiveTagIds: ids.optional(),
      positiveEntityIds: ids.optional(),
      excludedTagIds: ids.optional(),
      excludedEntityIds: ids.optional(),
    })
    .strict(),
  request_enrichment: z
    .object({ reasonCode: z.literal("insufficient_metadata"), entityIds: z.array(z.string().min(1).max(200)).min(1).max(3) })
    .strict(),
  finish_discovery: z.object({ reasonCode: z.literal("stable_recommendations") }).strict(),
} as const;

const PERMISSION: Record<ToolName, keyof AgentDecisionContext["permissions"]> = {
  ask_question: "ask",
  request_retrieval: "retrieve",
  request_enrichment: "enrich",
  finish_discovery: "finish",
};

export function permittedTools(context: AgentDecisionContext): ToolName[] {
  return TOOL_NAMES.filter((name) => context.permissions[PERMISSION[name]]);
}

const STRING = { type: "STRING" } as const;
const stringEnum = (values: string[], description?: string) => ({ ...STRING, enum: values, ...(description ? { description } : {}) });
const idArray = (values: string[], description: string) => ({ type: "ARRAY", items: stringEnum(values), description });

/** Gemini functionDeclarations for the permitted tools (OpenAPI-subset schemas, as verified in S2). */
export function functionDeclarations(context: AgentDecisionContext): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const name of permittedTools(context)) {
    if (name === "ask_question") {
      out.push({
        name,
        description: "Ask the user one approved preference question. Choose only from the listed question IDs.",
        parameters: {
          type: "OBJECT",
          properties: {
            questionId: stringEnum(context.questions.map((q) => q.questionId), "An approved question ID, copied exactly."),
            reasonCode: stringEnum(["informative_question"]),
          },
          required: ["questionId", "reasonCode"],
        },
      });
    } else if (name === "request_retrieval") {
      const properties: Record<string, unknown> = { reasonCode: stringEnum(["insufficient_candidates"]) };
      if (context.positive.tagIds.length) properties.positiveTagIds = idArray(context.positive.tagIds, "Confirmed liked tag IDs to emphasise.");
      if (context.positive.entityIds.length) properties.positiveEntityIds = idArray(context.positive.entityIds, "Confirmed preferred entity IDs.");
      if (context.negative.tagIds.length) properties.excludedTagIds = idArray(context.negative.tagIds, "Confirmed rejected tag IDs to exclude.");
      if (context.negative.entityIds.length) properties.excludedEntityIds = idArray(context.negative.entityIds, "Confirmed rejected entity IDs to exclude.");
      out.push({
        name,
        description: "Request a fresh recommendation retrieval using only the user's confirmed preferences. The server decides whether and how to execute it.",
        parameters: { type: "OBJECT", properties, required: ["reasonCode"] },
      });
    } else if (name === "request_enrichment") {
      out.push({
        name,
        description: "Request more verified metadata for up to 3 listed candidate entities.",
        parameters: {
          type: "OBJECT",
          properties: {
            entityIds: idArray(context.candidates.map((c) => c.entityId), "1 to 3 candidate entity IDs."),
            reasonCode: stringEnum(["insufficient_metadata"]),
          },
          required: ["entityIds", "reasonCode"],
        },
      });
    } else {
      out.push({
        name,
        description: "Stop asking questions; the current verified shortlist is good enough.",
        parameters: { type: "OBJECT", properties: { reasonCode: stringEnum(["stable_recommendations"]) }, required: ["reasonCode"] },
      });
    }
  }
  return out;
}

const subset = (values: string[] | undefined, allowed: string[]) => (values ?? []).every((v) => allowed.includes(v));

/** Validates one model function call against the registry and context, then converts it. */
export function parseToolCall(name: string, rawArgs: unknown, context: AgentDecisionContext): ParsedToolCall {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return { ok: false, tool: name, rejection: "unknown_tool" };
  const tool = name as ToolName;
  if (!context.permissions[PERMISSION[tool]]) return { ok: false, tool, rejection: "tool_not_permitted" };

  const args = ARG_SCHEMAS[tool].safeParse(rawArgs);
  if (!args.success) return { ok: false, tool, rejection: "invalid_arguments" };

  let decision: AgentDecision;
  let intent: AgentIntent | undefined;
  switch (tool) {
    case "ask_question": {
      const { questionId } = args.data as z.infer<(typeof ARG_SCHEMAS)["ask_question"]>;
      if (!context.questions.some((q) => q.questionId === questionId)) return { ok: false, tool, rejection: "unknown_question_id" };
      decision = { action: "ask", selectedQuestionId: questionId, reasonCode: "informative_question", done: false };
      break;
    }
    case "request_retrieval": {
      const a = args.data as z.infer<(typeof ARG_SCHEMAS)["request_retrieval"]>;
      if (
        !subset(a.positiveTagIds, context.positive.tagIds) ||
        !subset(a.positiveEntityIds, context.positive.entityIds) ||
        !subset(a.excludedTagIds, context.negative.tagIds) ||
        !subset(a.excludedEntityIds, context.negative.entityIds)
      ) {
        return { ok: false, tool, rejection: "unknown_preference_id" };
      }
      decision = { action: "retrieve", reasonCode: "insufficient_candidates", done: false };
      intent = {
        kind: "retrieval",
        positiveTagIds: [...new Set(a.positiveTagIds ?? [])],
        positiveEntityIds: [...new Set(a.positiveEntityIds ?? [])],
        excludedTagIds: [...new Set(a.excludedTagIds ?? [])],
        excludedEntityIds: [...new Set(a.excludedEntityIds ?? [])],
      };
      break;
    }
    case "request_enrichment": {
      const a = args.data as z.infer<(typeof ARG_SCHEMAS)["request_enrichment"]>;
      const known = context.candidates.map((c) => c.entityId);
      if (!subset(a.entityIds, known)) return { ok: false, tool, rejection: "unknown_entity_id" };
      decision = { action: "enrich", reasonCode: "insufficient_metadata", done: false };
      intent = { kind: "enrichment", entityIds: [...new Set(a.entityIds)] };
      break;
    }
    default:
      decision = { action: "finish", reasonCode: "stable_recommendations", done: true };
  }

  // Canonical validation; for `ask` this also swaps in the approved server-side text.
  try {
    const validated = validateAgentDecision(AgentDecisionSchema.parse(decision), offeredQuestions(context));
    return { ok: true, tool, decision: validated, ...(intent ? { intent } : {}) };
  } catch {
    return { ok: false, tool, rejection: "invalid_decision" };
  }
}
