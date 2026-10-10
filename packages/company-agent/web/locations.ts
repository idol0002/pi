import type { SourceLocation } from "../src/types.ts";

export function locationLabel(locations: SourceLocation[] | undefined, start: number, end: number): string {
	const pages = [...new Set((locations ?? []).flatMap((location) => (location.page === null ? [] : [location.page])))];
	if (pages.length > 0) return `第 ${pages.join("、")} 页`;
	return locations?.[0]?.label ?? `第 ${start}–${end} 行`;
}
