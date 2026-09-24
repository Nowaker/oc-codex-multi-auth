import { describe, expect, it } from "vitest";
import { protectQuotaStatusSlot } from "../tui.js";

function hostSlot(extraChild = false) {
	let shrink = 1;
	const node: { parent?: object } = {};
	const parent = {
		getChildren: () => extraChild ? [node, {}] : [node],
		yogaNode: { getFlexShrink: () => shrink },
		set flexShrink(value: number) { shrink = value; },
	};
	node.parent = parent;
	return { node, parent, readShrink: () => shrink };
}

describe("quota slot secondary shrink", () => {
	it("protects an exclusive wrapper and restores its original shrink on cleanup", () => {
		// Given
		const slot = hostSlot();
		// When
		const restore = protectQuotaStatusSlot(slot.node);
		// Then
		expect(slot.readShrink()).toBe(0);
		expect(restore).toBeTypeOf("function");
		restore?.();
		expect(slot.readShrink()).toBe(1);
	});

	it("leaves shared host wrappers unchanged", () => {
		// Given
		const slot = hostSlot(true);
		// When
		const restore = protectQuotaStatusSlot(slot.node);
		// Then
		expect(restore).toBeUndefined();
		expect(slot.readShrink()).toBe(1);
	});

	it("does not overwrite a later host layout change during cleanup", () => {
		// Given
		const slot = hostSlot();
		const restore = protectQuotaStatusSlot(slot.node);
		slot.parent.flexShrink = 2;
		// When
		restore?.();
		// Then
		expect(slot.readShrink()).toBe(2);
	});

	it("does not guess a shrink value on an unsupported or unmounted host", () => {
		// Given / When / Then
		expect(protectQuotaStatusSlot({})).toBeUndefined();
		expect(protectQuotaStatusSlot({ parent: {} })).toBeUndefined();
	});
});
