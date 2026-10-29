import type { ApiErrorCode } from "@/lib/contracts";

/** Typed application error. `message` is safe to return to clients. */
export class AppError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}
