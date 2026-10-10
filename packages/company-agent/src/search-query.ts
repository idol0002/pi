/**
 * 把自然语言问题变成检索计划：去除虚词、判断是否承接上文、补充少量意图词。
 * 这是可解释的语言规则，不额外调用模型；上一轮资料是否仍可用由 chat.ts 先验证。
 */
import { searchTerms } from "./text-processing.ts";

const words = new Intl.Segmenter("zh", { granularity: "word" });
const stopWords = new Set([
	"请",
	"请问",
	"一下",
	"我",
	"我们",
	"你",
	"你们",
	"的",
	"了",
	"吗",
	"呢",
	"啊",
	"呀",
	"是",
	"在",
	"有",
	"什么",
	"怎么",
	"如何",
	"哪些",
	"是否",
	"可以",
	"能",
	"能够",
	"需要",
	"要",
	"一个",
	"这个",
	"那个",
	"这些",
	"那些",
	"它",
	"那么",
	"然后",
	"还有",
	"那",
	"谁",
	"多久",
	"几天",
	"多少",
	"the",
	"a",
	"an",
	"is",
	"are",
	"am",
	"was",
	"were",
	"do",
	"does",
	"did",
	"can",
	"could",
	"would",
	"please",
	"what",
	"which",
	"how",
	"who",
	"when",
	"where",
	"i",
	"we",
	"you",
	"it",
	"this",
	"that",
	"to",
	"of",
	"for",
	"in",
	"on",
	"and",
	"or",
	"about",
]);
const followUpActions = new Set([
	"批",
	"审批",
	"批准",
	"办理",
	"处理",
	"完成",
	"下来",
	"材料",
	"时间",
	"费用",
	"long",
	"take",
	"approval",
	"approve",
	"approved",
	"cost",
]);

export interface SearchPlan {
	keywordQuery: string;
	terms: string[];
	expandedTerms: string[];
	embeddingText: string;
	contextual: boolean;
	contextDocumentIds: string[];
}

export function meaningfulTerms(text: string): string[] {
	// 留下能区分主题的词；索引侧的完整词项扩展在 text-processing.searchTerms 中。
	const terms = new Set<string>();
	for (const part of words.segment(text.normalize("NFKC").toLowerCase())) {
		if (
			part.isWordLike &&
			/^[\p{L}\p{N}]+$/u.test(part.segment) &&
			part.segment.length <= 64 &&
			!stopWords.has(part.segment)
		) {
			terms.add(part.segment);
		}
	}
	return [...terms];
}

/** 调用方只能传入当前仍有权限且有效的完成历史；本函数本身不查询数据库授权。 */
export function planSearch(question: string, previousQuestion?: string, contextDocumentIds: string[] = []): SearchPlan {
	// “那多久能批”可承接上文；若引入 VPN 等新主题，则仍按新问题独立检索。
	const followUp =
		/^(那|那么|然后|还有|它|这个|上述|这项|该流程)|多久|几天|多长时间|多少(?:钱|天)|^(and\b|what about\b|how long\b|how much\b|does it\b)/i.test(
			question.trim(),
		);
	const currentTerms = meaningfulTerms(question);
	const previousTerms = meaningfulTerms(previousQuestion ?? "");
	const newTopics = currentTerms.filter((term) => !followUpActions.has(term) && !previousTerms.includes(term));
	const contextual = Boolean(previousQuestion && followUp && newTopics.length === 0);
	const rawTerms = [
		...new Set([...(contextual ? meaningfulTerms(previousQuestion ?? "").slice(0, 10) : []), ...currentTerms]),
	];
	const terms: string[] = [];
	for (const term of rawTerms) {
		const candidate = [...terms, term].join(" ");
		if (candidate.length > 240 || searchTerms(candidate).length > 48) break;
		terms.push(term);
	}
	// 保留有限预算给“工作日/时限”等问题意图，避免长问题将查询长度和词项数耗尽。
	const expandedTerms: string[] = [];
	const chinese = /\p{Script=Han}/u.test(question);
	if (/多久|几天|多长时间|how long|duration/i.test(question)) {
		expandedTerms.push(...(chinese ? ["时限", "时间", "工作日"] : ["time", "days", "duration"]));
	}
	if (/多少(?:钱)?|how much|cost/i.test(question)) {
		expandedTerms.push(...(chinese ? ["金额", "上限", "标准"] : ["amount", "limit", "cost"]));
	}
	let keywordQuery = terms.join(" ");
	for (const term of expandedTerms) {
		const candidate = keywordQuery ? `${keywordQuery} ${term}` : term;
		if (candidate.length <= 300 && searchTerms(candidate).length <= 64) keywordQuery = candidate;
	}
	// keywordQuery 服务于词项匹配；embeddingText 保留更完整的自然语言上下文。
	return {
		keywordQuery,
		terms,
		expandedTerms,
		contextual,
		contextDocumentIds: contextual ? [...new Set(contextDocumentIds)] : [],
		embeddingText: contextual
			? `上一个问题：${previousQuestion?.slice(0, 800)}\n追问：${question.slice(0, 2000)}`
			: question.slice(0, 2000),
	};
}
