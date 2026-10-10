/** 将来源位置转成人能读的提示：优先 PDF 页码，其次 Word 正文块，最后使用文本行号。 */
import type { SourceLocation } from "../src/types.ts";

export function locationLabel(locations: SourceLocation[] | undefined, start: number, end: number): string {
	const pages = [...new Set((locations ?? []).flatMap((location) => (location.page === null ? [] : [location.page])))];
	if (pages.length > 0) return `第 ${pages.join("、")} 页`;
	return locations?.[0]?.label ?? `第 ${start}–${end} 行`;
}
