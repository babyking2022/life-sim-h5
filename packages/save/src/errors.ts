export const MAX_COMPRESSED_BYTES = 5 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;

export type SaveErrorCode =
  | "E_SAVE_TOO_LARGE"
  | "E_SAVE_INVALID"
  | "E_SAVE_UNSUPPORTED_VERSION"
  | "E_SAVE_STATE_MISMATCH"
  | "E_SAVE_SEED_MISMATCH";

export class SaveError extends Error {
  constructor(
    public readonly code: SaveErrorCode,
    message: string = code
  ) {
    super(message);
    this.name = "SaveError";
  }
}

export function failSave(code: SaveErrorCode, message: string): never {
  throw new SaveError(code, message);
}
