import type { RawInsightEntity } from "../../src/lib/qloo/raw-types";
import type { Server } from "node:https";
export const ARTISTS: RawInsightEntity[];
export function startQlooStub(options?: { extended?: boolean; retained?: boolean }): Promise<Server>;
