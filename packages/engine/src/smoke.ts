import { asPppMicro, encodeMoney, moneyAdd } from "./money";

export const bigintLiteralSmoke: bigint = 1n + 1n;
export const bigintTypeSmoke = typeof bigintLiteralSmoke;

const onePppUsd = asPppMicro(1_000_000n);
export const moneySmoke = encodeMoney(moneyAdd(onePppUsd, onePppUsd));
