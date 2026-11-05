export type MoneyString = string & { readonly __brand: "MoneyString" };

export const MONEY_STRING_MAX_LENGTH = 40;
export const MONEY_STRING_PATTERN = /^-?(0|[1-9][0-9]*)$/;

export function isMoneyString(value: unknown): value is MoneyString {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MONEY_STRING_MAX_LENGTH) return false;
  if (value === "-0") return false;
  return MONEY_STRING_PATTERN.test(value);
}
