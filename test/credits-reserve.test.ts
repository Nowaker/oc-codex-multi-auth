import { describe, expect, it } from "vitest";
import { CreditsRefusals, pickCreditsReserveIndex } from "../lib/accounts/credits-reserve.js";

const entry = (index: number, eligible: boolean, reasons: string[]) => ({ index, eligible, reasons });
const none = new Set<number>();
const always = () => true;
const never = () => false;

describe("pickCreditsReserveIndex", () => {
	it("offers nothing while any account can still serve on its plan quota", () => {
		const explained = [entry(0, false, ["quota-exhausted"]), entry(1, true, ["eligible"])];
		expect(pickCreditsReserveIndex(explained, { attempted: none, inPool: always, refused: never })).toBeUndefined();
	});

	it("offers an account blocked only by its spent subscription window once none can", () => {
		const explained = [
			entry(0, false, ["rate-limited", "quota-exhausted"]),
			entry(1, false, ["disabled"]),
			entry(2, false, ["quota-exhausted"]),
		];
		expect(pickCreditsReserveIndex(explained, { attempted: none, inPool: always, refused: never })).toBe(2);
	});

	it("skips attempted, refused and out-of-pool accounts", () => {
		const explained = [
			entry(0, false, ["quota-exhausted"]),
			entry(1, false, ["quota-exhausted"]),
			entry(2, true, ["eligible"]),
			entry(3, false, ["quota-exhausted"]),
			entry(4, false, ["quota-exhausted"]),
		];
		expect(pickCreditsReserveIndex(explained, {
			attempted: new Set([0]),
			inPool: (index) => index !== 2,
			refused: (index) => index === 1 || index === 3,
		})).toBe(4);
	});

	it("offers nothing while an account tried this request still has plan quota", () => {
		const explained = [entry(0, true, ["eligible"]), entry(1, false, ["quota-exhausted"])];
		expect(pickCreditsReserveIndex(explained, { attempted: new Set([0]), inPool: always, refused: never })).toBeUndefined();
	});

	it.each([
		[["rate-limited"]],
		[["cooldown:network-error"]],
		[["cooldown"]],
		[["token-bucket-empty"]],
	])("waits for an account only delayed by %j instead of spending credits", (reasons) => {
		const explained = [entry(0, false, reasons), entry(1, false, ["quota-exhausted"])];
		expect(pickCreditsReserveIndex(explained, { attempted: none, inPool: always, refused: never })).toBeUndefined();
	});

	it("does not wait for a disabled account or one whose login failed", () => {
		const explained = [
			entry(0, false, ["disabled"]),
			entry(1, false, ["cooldown:auth-failure"]),
			entry(2, false, ["quota-exhausted"]),
		];
		expect(pickCreditsReserveIndex(explained, { attempted: none, inPool: always, refused: never })).toBe(2);
	});

	it("does not serve an account whose token bucket or cooldown blocks it too", () => {
		const explained = [entry(0, false, ["quota-exhausted", "token-bucket-empty"]), entry(1, false, ["quota-exhausted", "cooldown"])];
		expect(pickCreditsReserveIndex(explained, { attempted: none, inPool: always, refused: never })).toBeUndefined();
	});
});

describe("CreditsRefusals", () => {
	it("keeps a refusal per account and quota key until it resets", () => {
		let now = 1_000;
		const refusals = new CreditsRefusals(() => now);
		refusals.mark("acct", "gpt-5.4", 2_000);
		expect(refusals.isRefused("acct", "gpt-5.4")).toBe(true);
		expect(refusals.isRefused("acct", "gpt-5.5")).toBe(false);
		expect(refusals.isRefused("other", "gpt-5.4")).toBe(false);
		now = 2_000;
		expect(refusals.isRefused("acct", "gpt-5.4")).toBe(false);
	});
});
