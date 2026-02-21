import { getStructuredSectionTitles } from "./section-titles.ts";

export type StructuredSectionKey = "description" | "implementationPlan" | "finalSummary";

export const STRUCTURED_SECTION_KEYS: Record<StructuredSectionKey, StructuredSectionKey> = {
	description: "description",
	implementationPlan: "implementationPlan",
	finalSummary: "finalSummary",
};

interface SectionConfig {
	title: string;
	markerId: string;
}

const SECTION_CONFIG: Record<StructuredSectionKey, SectionConfig> = {
	description: { title: "Description", markerId: "DESCRIPTION" },
	implementationPlan: { title: "Implementation Plan", markerId: "PLAN" },
	finalSummary: { title: "Final Summary", markerId: "FINAL_SUMMARY" },
};

const SECTION_INSERTION_ORDER: StructuredSectionKey[] = [
	"description",
	"implementationPlan",
	"finalSummary",
];

const KNOWN_SECTION_TITLES = new Set<string>([...getStructuredSectionTitles()]);

function normalizeToLF(content: string): { text: string; useCRLF: boolean } {
	const useCRLF = /\r\n/.test(content);
	return { text: content.replace(/\r\n/g, "\n"), useCRLF };
}

function restoreLineEndings(text: string, useCRLF: boolean): string {
	return useCRLF ? text.replace(/\n/g, "\r\n") : text;
}

function escapeForRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getConfig(key: StructuredSectionKey): SectionConfig {
	return SECTION_CONFIG[key];
}

function getBeginMarker(key: StructuredSectionKey): string {
	return `<!-- SECTION:${getConfig(key).markerId}:BEGIN -->`;
}

function getEndMarker(key: StructuredSectionKey): string {
	return `<!-- SECTION:${getConfig(key).markerId}:END -->`;
}

function buildSectionBlock(key: StructuredSectionKey, body: string): string {
	const { title } = getConfig(key);
	const begin = getBeginMarker(key);
	const end = getEndMarker(key);
	const normalized = body.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
	const content = normalized ? `${normalized}\n` : "";
	return `## ${title}\n\n${begin}\n${content}${end}`;
}

function structuredSectionLookahead(currentTitle: string): string {
	const otherTitles = Array.from(KNOWN_SECTION_TITLES).filter(
		(title) => title.toLowerCase() !== currentTitle.toLowerCase(),
	);
	if (otherTitles.length === 0) return "(?=\\n*$)";
	const pattern = otherTitles.map((title) => escapeForRegex(title)).join("|");
	return `(?=\\n+## (?:${pattern})(?:\\s|$)|\\n*$)`;
}

function sectionHeaderRegex(key: StructuredSectionKey): RegExp {
	const { title } = getConfig(key);
	return new RegExp(`## ${escapeForRegex(title)}\\s*\\n([\\s\\S]*?)${structuredSectionLookahead(title)}`, "i");
}

function legacySectionRegex(title: string, flags: string): RegExp {
	return new RegExp(`(\\n|^)## ${escapeForRegex(title)}\\s*\\n([\\s\\S]*?)${structuredSectionLookahead(title)}`, flags);
}

function findSectionEndIndex(content: string, title: string): number | undefined {
	const normalizedTitle = title.trim();
	const keyEntry = Object.entries(SECTION_CONFIG).find(
		([, config]) => config.title.toLowerCase() === normalizedTitle.toLowerCase(),
	);
	if (keyEntry) {
		const key = keyEntry[0] as StructuredSectionKey;
		const sentinelMatch = new RegExp(
			`## ${escapeForRegex(getConfig(key).title)}\\s*\\n${escapeForRegex(getBeginMarker(key))}\\s*\\n([\\s\\S]*?)${escapeForRegex(getEndMarker(key))}`,
			"i",
		).exec(content);
		if (sentinelMatch) {
			return sentinelMatch.index + sentinelMatch[0].length;
		}
	}

	const legacyMatch = legacySectionRegex(normalizedTitle, "i").exec(content);
	if (legacyMatch) {
		return legacyMatch.index + legacyMatch[0].length;
	}
	return undefined;
}

function sentinelBlockRegex(key: StructuredSectionKey): RegExp {
	const { title } = getConfig(key);
	const begin = escapeForRegex(getBeginMarker(key));
	const end = escapeForRegex(getEndMarker(key));
	return new RegExp(`## ${escapeForRegex(title)}\\s*\\n${begin}\\s*\\n([\\s\\S]*?)${end}`, "i");
}

interface SectionRange {
	key: StructuredSectionKey;
	start: number;
	end: number;
	kind: "sentinel" | "legacy";
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	return aStart < bEnd && bStart < aEnd;
}

function isIndexWithinRanges(index: number, ranges: SectionRange[]): boolean {
	return ranges.some((range) => index >= range.start && index < range.end);
}

function findMatchOutsideRanges(regex: RegExp, content: string, ranges: SectionRange[]): RegExpExecArray | undefined {
	const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
	const globalRegex = new RegExp(regex.source, flags);
	for (const match of content.matchAll(globalRegex)) {
		const index = match.index ?? 0;
		if (!isIndexWithinRanges(index, ranges)) return match;
	}
	return undefined;
}

function getStructuredSectionRanges(content: string): SectionRange[] {
	const ranges: SectionRange[] = [];
	for (const key of SECTION_INSERTION_ORDER) {
		const sentinel = new RegExp(sentinelBlockRegex(key).source, "gi");
		for (const match of content.matchAll(sentinel)) {
			const index = match.index ?? 0;
			ranges.push({ key, start: index, end: index + match[0].length, kind: "sentinel" });
		}

		const legacy = legacySectionRegex(getConfig(key).title, "gi");
		for (const match of content.matchAll(legacy)) {
			const index = match.index ?? 0;
			const end = index + match[0].length;
			if (ranges.some((range) => rangesOverlap(range.start, range.end, index, end))) continue;
			ranges.push({ key, start: index, end, kind: "legacy" });
		}
	}
	return ranges;
}

function stripSectionInstances(content: string, key: StructuredSectionKey): string {
	const beginEsc = escapeForRegex(getBeginMarker(key));
	const endEsc = escapeForRegex(getEndMarker(key));
	const { title } = getConfig(key);

	let stripped = content;
	const sentinelRegex = new RegExp(
		`(\n|^)## ${escapeForRegex(title)}\\s*\\n${beginEsc}\\s*\\n([\\s\\S]*?)${endEsc}(?:\\s*\n|$)`,
		"gi",
	);
	stripped = stripped.replace(sentinelRegex, "\n");

	const legacy = legacySectionRegex(title, "gi");
	stripped = stripped.replace(legacy, "\n");

	return stripped.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function insertAfterSection(content: string, title: string, block: string): { inserted: boolean; content: string } {
	if (!block.trim()) return { inserted: false, content };
	const insertPos = findSectionEndIndex(content, title);
	if (insertPos === undefined) return { inserted: false, content };
	const before = content.slice(0, insertPos).trimEnd();
	const after = content.slice(insertPos).replace(/^\s+/, "");
	const newContent = `${before}${before ? "\n\n" : ""}${block}${after ? `\n\n${after}` : ""}`;
	return { inserted: true, content: newContent };
}

function insertAtStart(content: string, block: string): string {
	const trimmedBlock = block.trim();
	if (!trimmedBlock) return content;
	const trimmedContent = content.trim();
	if (!trimmedContent) return trimmedBlock;
	return `${trimmedBlock}\n\n${trimmedContent}`;
}

function appendBlock(content: string, block: string): string {
	const trimmedBlock = block.trim();
	if (!trimmedBlock) return content;
	const trimmedContent = content.trim();
	if (!trimmedContent) return trimmedBlock;
	return `${trimmedContent}\n\n${trimmedBlock}`;
}

export function extractStructuredSection(content: string, key: StructuredSectionKey): string | undefined {
	const src = content.replace(/\r\n/g, "\n");
	const otherRanges = getStructuredSectionRanges(src).filter((range) => range.key !== key);
	const sentinelMatch = findMatchOutsideRanges(sentinelBlockRegex(key), src, otherRanges);
	if (sentinelMatch?.[1]) {
		return sentinelMatch[1].trim() || undefined;
	}
	const legacyMatch = findMatchOutsideRanges(sectionHeaderRegex(key), src, otherRanges);
	return legacyMatch?.[1]?.trim() || undefined;
}

export interface StructuredSectionValues {
	description?: string;
	implementationPlan?: string;
	finalSummary?: string;
}

export function updateStructuredSections(content: string, sections: StructuredSectionValues): string {
	const { text: src, useCRLF } = normalizeToLF(content);

	let working = src;
	for (const key of SECTION_INSERTION_ORDER) {
		working = stripSectionInstances(working, key);
	}
	working = working.trim();

	const description = sections.description?.trim() || "";
	const plan = sections.implementationPlan?.trim() || "";
	const finalSummary = sections.finalSummary?.trim() || "";

	let tail = working;

	if (plan) {
		const planBlock = buildSectionBlock("implementationPlan", plan);
		let res = insertAfterSection(tail, getConfig("description").title, planBlock);
		if (!res.inserted) {
			tail = insertAtStart(tail, planBlock);
		} else {
			tail = res.content;
		}
	}

	if (finalSummary) {
		const finalBlock = buildSectionBlock("finalSummary", finalSummary);
		let res = insertAfterSection(tail, getConfig("implementationPlan").title, finalBlock);
		if (!res.inserted) {
			tail = appendBlock(tail, finalBlock);
		} else {
			tail = res.content;
		}
	}

	let output = tail;
	if (description) {
		const descriptionBlock = buildSectionBlock("description", description);
		output = insertAtStart(tail, descriptionBlock);
	}

	const finalOutput = output.replace(/\n{3,}/g, "\n\n").trim();
	return restoreLineEndings(finalOutput, useCRLF);
}

export function getStructuredSections(content: string): StructuredSectionValues {
	return {
		description: extractStructuredSection(content, "description") || undefined,
		implementationPlan: extractStructuredSection(content, "implementationPlan") || undefined,
		finalSummary: extractStructuredSection(content, "finalSummary") || undefined,
	};
}
