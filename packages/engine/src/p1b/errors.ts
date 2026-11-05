export type P1BErrorCode =
  | "INVALID_EFFECT"
  | "INVALID_COMMAND"
  | "INVALID_STATE"
  | "INVALID_ENVELOPE"
  | "INVALID_VERSION"
  | "INVALID_PRESENTATION"
  | "INVALID_COMMAND_LOG"
  | "UNSUPPORTED_RNG_SPEC"
  | "E_SAVE_TOO_LARGE"
  | "HASH_MISMATCH";

export class P1BError extends Error {
  constructor(
    public readonly code: P1BErrorCode,
    message: string = code
  ) {
    super(message);
    this.name = "P1BError";
  }
}

export class ReplayDivergenceError extends Error {
  public readonly code = "DIVERGED_AT_YEAR" as const;

  constructor(
    public readonly index: number,
    public readonly year: number,
    public readonly expectedHash: string,
    public readonly actualHash: string
  ) {
    super(`DIVERGED_AT_YEAR:${index}:${year}`);
    this.name = "ReplayDivergenceError";
  }
}
