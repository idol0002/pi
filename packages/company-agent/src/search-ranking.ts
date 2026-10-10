import type { SearchPlan } from "./search-query.ts";
import { searchTerms } from "./text-processing.ts";
import type { SearchHit } from "./types.ts";

export function rankKeywordHits(hits: SearchHit[], plan: SearchPlan): SearchHit[] {
	if (plan.terms.length === 0) return [];
	const ranked: SearchHit[] = [];
	for (const hit of hits) {
		const title = hit.title.normalize("NFKC").toLowerCase();
		const heading = (hit.heading ?? "").normalize("NFKC").toLowerCase();
		const text = hit.text.normalize("NFKC").toLowerCase();
		const full = `${title}\n${heading}\n${text}`;
		const fullTerms = new Set(searchTerms(full));
		const titleTerms = new Set(searchTerms(title));
		const headingTerms = new Set(searchTerms(heading));
		const bodyTerms = new Set(searchTerms(text));
		const matched = plan.terms.filter((term) => fullTerms.has(term));
		const coverage = matched.length / plan.terms.length;
		const intentMatches = Math.min(3, plan.expandedTerms.filter((term) => fullTerms.has(term)).length);
		const anchoredIntent = plan.contextual && plan.contextDocumentIds.includes(hit.documentId) && intentMatches > 0;
		// Long questions often contain background prose. Require at least two useful terms.
		if (!anchoredIntent && (matched.length === 0 || (plan.terms.length > 8 ? matched.length < 2 : coverage < 0.4)))
			continue;
		const score =
			coverage * 5 +
			matched.filter((term) => titleTerms.has(term)).length * 0.4 +
			matched.filter((term) => headingTerms.has(term)).length * 0.25 +
			intentMatches * (anchoredIntent ? 2 : 0.3) +
			Math.min(1, hit.score) +
			(matched.filter((term) => bodyTerms.has(term)).length / Math.max(1, bodyTerms.size)) * 0.5;
		ranked.push({ ...hit, score });
	}
	return ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

/** Deduplicate repeated excerpts; reserve room for other documents before filling remaining slots. */
export function selectSources(hits: SearchHit[], limit: number): SearchHit[] {
	const seen = new Set<string>();
	const unique = hits.filter((hit) => {
		const key = hit.text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const counts = new Map<string, number>();
	const selected: SearchHit[] = [];
	const deferred: SearchHit[] = [];
	const perDocument = Math.max(2, Math.ceil(limit / 2));
	for (const hit of unique) {
		const count = counts.get(hit.documentId) ?? 0;
		if (count >= perDocument) deferred.push(hit);
		else {
			selected.push(hit);
			counts.set(hit.documentId, count + 1);
		}
		if (selected.length === limit) return selected;
	}
	return [...selected, ...deferred].slice(0, limit);
}

export function fuseRanks(keyword: SearchHit[], semantic: SearchHit[], limit: number): SearchHit[] {
	const merged = new Map<string, SearchHit>();
	for (const list of [keyword, semantic]) {
		for (const [index, hit] of list.entries()) {
			const score = (merged.get(hit.id)?.score ?? 0) + 1 / (40 + index + 1);
			merged.set(hit.id, { ...hit, score });
		}
	}
	return selectSources(
		[...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
		limit,
	);
}
