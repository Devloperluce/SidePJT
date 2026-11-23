#!/usr/bin/env node
/**
 * Pay Brief — 결제·핀테크 뉴스 수집 → 중복 제거 → 요약·분류·시사점 → data/YYYY-MM-DD.json
 *
 * 브리프 날짜 D = 전날(D-1) 07:00 ~ D 07:00 (KST)에 나온 기사. 실행 시각과 무관하게 같은 구간을 쓴다.
 *
 * 사용법
 *   node scripts/build-brief.js --collect-only                 # 수집 결과만 콘솔에
 *   node scripts/build-brief.js --candidates FILE [--merge]    # 후보 저장 (--merge: 기존 파일에 누적)
 *   node scripts/build-brief.js --assemble SUMS --candidates FILE   # 요약 JSON을 검증·조립해 data/에 저장
 *   node scripts/build-brief.js [--limit N]                    # API 키로 수집+요약+저장 한 번에
 *   공통: --date YYYY-MM-DD (기본: 오늘, KST)
 *
 * 출처
 *   - Google 뉴스 키워드 검색: 폭넓게 찾지만 기사 설명이 비어 있다
 *   - 언론사 공식 RSS: 기사 앞부분(리드)이 있어 요약 재료가 된다. 결제 핵심어로 걸러 쓴다
 *   같은 기사면 언론사 RSS 쪽(리드·원문 직링크 있음)을 남긴다.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Parser = require("rss-parser");

// ───────── 설정 ─────────
const KEYWORDS = [
  "간편결제",
  "PG사", // 원안 "PG사 OR 전자결제대행": 24h 기사 0건이 잦아 교체 (2026-11-18)
  "정산 결제", // 원안 "정산 핀테크": 24h 기사 0건이 잦아 교체 (2026-11-18)
  "스테이블코인 결제",
  "AI 에이전트 결제",
  "금융위원회 핀테크",
];
const googleNewsUrl = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;

// 언론사 공식 RSS (2026-11-23 GitHub Actions에서 응답·리드 포함 여부 확인).
// 한국경제(설명 없음), 디지털데일리(0건), 아이뉴스24·전자신문 금융(404), 세계파이낸스(인증서 오류)는 제외.
const PUBLISHER_FEEDS = [
  ["머니투데이", "https://rss.mt.co.kr/mt_news.xml"],
  ["파이낸셜뉴스", "https://www.fnnews.com/rss/r20/fn_realnews_finance.xml"],
  ["전자신문", "https://rss.etnews.com/Section901.xml"],
  ["블로터", "https://www.bloter.net/rss/allArticle.xml"],
  ["디지털투데이", "https://www.digitaltoday.co.kr/rss/allArticle.xml"],
  ["서울파이낸스", "https://www.seoulfn.com/rss/allArticle.xml"],
  ["지디넷코리아", "https://feeds.feedburner.com/zdkorea"],
  ["뉴스핌", "https://rss.newspim.com/news/category/104"],
  ["바이라인네트워크", "https://byline.network/feed/"],
  ["블록미디어", "https://www.blockmedia.co.kr/feed"],
  ["매일경제", "https://www.mk.co.kr/rss/50200011/"],
];

const MAX_CANDIDATES = 40; // 하루 후보 상한 (요약 단계에서 무관 기사는 또 빠진다)
const PER_FEED = 6; // 출처(키워드·언론사)별 상한
const WINDOW_HOURS = 24;
const CUTOFF_HOUR_KST = 7; // 브리프 마감 시각
const DESC_MAX = 400; // 요약 재료로 남길 리드 길이 (페이지에는 싣지 않는다)
const MODEL = "claude-haiku-5-5";
const CONCURRENCY = 4;
const CATEGORIES = ["payment", "settlement", "ai_agent", "regulation", "market"];

// Google 뉴스 결과 1차 필터 (제목 기준): 키워드 일부만 맞아도 걸려 오므로 결제 핵심어가 있어야 통과
const CORE_TERMS =
  /결제|페이|pay|PG|정산|송금|카드|스테이블코인|핀테크|간편|수수료|가맹점|지갑|월렛|wallet|환전|외환|선불|후불|BNPL|전자금융|지급|빌링|이체|계좌|토스|머니/i;
// 언론사 RSS는 전 분야 기사가 섞여 있어 더 좁은 핵심어로 거른다
const STRICT_TERMS =
  /결제|페이(?![지스])|PG사|\bPG\b|정산|송금|간편|스테이블코인|핀테크|가맹점|선불|BNPL|전자금융|지급결제|빌링|월렛|오픈뱅킹|마이데이터|카드사|환전|토스|카카오페이|네이버페이|원화 ?코인/i;
const SPAM_TERMS = /할인코드|쿠폰|프로모션 ?코드|추천인|이벤트 응모|최저가|오늘의 운세|부고|인사\]/;
const STRICT_ALL = new RegExp(STRICT_TERMS.source, "gi");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

// ───────── 유틸 ─────────
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const COLLECT_ONLY = args.includes("--collect-only");
const MERGE = args.includes("--merge");
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : null;

/** Date → "2026-11-18T07:00:12+09:00" */
function toKstIso(d) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return k.toISOString().replace(/\.\d{3}Z$/, "+09:00");
}
const kstDate = (d) => toKstIso(d).slice(0, 10);

/** 브리프 날짜 D → { from: D-1 07:00, to: D 07:00 } (KST, epoch ms) */
function briefWindow(date) {
  const to = Date.parse(`${date}T${String(CUTOFF_HOUR_KST).padStart(2, "0")}:00:00+09:00`);
  return { from: to - WINDOW_HOURS * 3600 * 1000, to };
}
const BRIEF_DATE = argVal("--date") || kstDate(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(BRIEF_DATE) || isNaN(briefWindow(BRIEF_DATE).to)) {
  console.error(`--date 형식이 잘못됐습니다: ${BRIEF_DATE} (예: 2026-11-21)`);
  process.exit(1);
}

function stripHtml(s = "") {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 리드 앞의 매체·기자 표기 제거: "[파이낸셜뉴스]", "[서울=뉴스핌] 박우진 기자 =", "#OBJECT0#" 등 */
function cleanLead(s = "") {
  let t = s.replace(/#OBJECT\d+#/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/^\[[^\]]{1,40}\]\s*/, "")
      .replace(/^\([^)]{1,30}\)\s*/, "")
      .replace(/^[^.。=]{1,30}기자\s*=\s*/, "")
      .replace(/^■\s*/, "");
  }
  return t.length > DESC_MAX ? t.slice(0, DESC_MAX).replace(/\s\S*$/, "") + "…" : t;
}

/** RSS 날짜. "2026-11-23 16:37:36"처럼 시간대가 없으면 KST로 본다 */
function parseDate(raw) {
  const s = (raw.pubDate || raw["dc:date"] || raw.isoDate || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) return new Date(s.replace(" ", "T") + "+09:00");
  const d = new Date(s.replace(/^(\w{3}),(\d)/, "$1, $2")); // "Mon,23 Nov" 같은 표기 보정
  return isNaN(d) ? null : d;
}

function normalizeLink(link) {
  try {
    const u = new URL(link);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (k === "oc" || k.startsWith("utm_")) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^www\./, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return link.trim();
  }
}

/** 공백·특수문자 제거 후 앞 30자 */
const titleKey = (t) => t.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 30);
function bigrams(t) {
  const s = t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
/** 쉼표·가운뎃점 앞 주어 (예: "NHN KCP, ..." → "nhnkcp") */
const leadSubject = (t) =>
  t.replace(/^\[[^\]]*\]\s*/, "").split(/[,，·…]/)[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function overlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
}
/** 같은 사건을 다룬 다른 제목인지: 겹침 60%↑, 또는 같은 주어 + 겹침 35%↑ */
function isSameStory(a, b) {
  const o = overlap(a.bg, b.bg);
  if (o >= 0.6) return true;
  return a.lead.length >= 2 && a.lead.length <= 15 && a.lead === b.lead && o >= 0.35;
}
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

/** 언론사 RSS 기사 관련성: 제목에 핵심어, 또는 리드에 서로 다른 핵심어 2개 이상 */
function isRelevantPublisher(title, desc) {
  if (SPAM_TERMS.test(title)) return false;
  if (STRICT_TERMS.test(title)) return true;
  const hits = new Set((desc.slice(0, 200).match(STRICT_ALL) || []).map((x) => x.toLowerCase()));
  return hits.size >= 2;
}

// ───────── 1. 수집 ─────────
const parser = new Parser({ customFields: { item: ["source", "dc:date"] } });

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (PayBrief RSS reader)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parser.parseString(await res.text());
}

function toItem(raw, feed) {
  // Google 뉴스: <source>언론사</source>, 제목 끝에 " - 언론사"가 붙음
  const src = (typeof raw.source === "string" ? raw.source : raw.source?._) || feed.source || "";
  let title = stripHtml(raw.title || "");
  if (src && title.endsWith(` - ${src}`)) title = title.slice(0, -(src.length + 3)).trim();
  let source = src;
  if (/^https?:\/\//i.test(src)) {
    try {
      source = new URL(src).hostname.replace(/^www\./, "");
    } catch {}
  }
  let description = "";
  if (feed.kind === "publisher") {
    description = cleanLead(stripHtml(raw["content:encoded"] || raw.content || raw.contentSnippet || raw.description || ""));
  }
  return { title, source, description, link: (raw.link || "").trim(), publishedAt: parseDate(raw), feed: feed.label };
}

/** 후보를 최신순으로 훑으며 같은 기사·같은 사건을 합친다. 리드가 있는 쪽(언론사 RSS)을 남긴다 */
function select(pool) {
  pool.sort((a, b) => b.publishedAt - a.publishedAt);
  const kept = [];
  const perFeed = {};
  const seenLinks = new Set();
  let dupes = 0;
  for (const it of pool) {
    const nl = normalizeLink(it.link);
    if (seenLinks.has(nl)) continue;
    seenLinks.add(nl);
    const c = { ...it, id: it.id || sha1(nl), bg: bigrams(it.title), lead: leadSubject(it.title) };
    const same = kept.find((k) => titleKey(k.title) === titleKey(c.title) || isSameStory(k, c));
    if (same) {
      dupes++;
      if (!same.description && c.description) {
        // 언론사 버전으로 바꿔 단다 (리드·원문 직링크). 시각은 더 이른 쪽
        Object.assign(same, {
          title: c.title, source: c.source, description: c.description, link: c.link, id: c.id,
          bg: c.bg, lead: c.lead, publishedAt: same.publishedAt < c.publishedAt ? same.publishedAt : c.publishedAt,
        });
      }
      continue;
    }
    if (!c.prior) {
      if ((perFeed[c.feed] || 0) >= PER_FEED) continue;
      perFeed[c.feed] = (perFeed[c.feed] || 0) + 1;
    }
    kept.push(c);
  }
  console.log(`같은 기사·같은 사건 ${dupes}건 합침`);
  return kept
    .map(({ bg, lead, prior, ...rest }) => rest)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_CANDIDATES);
}

async function collect(existing = []) {
  const { from, to } = briefWindow(BRIEF_DATE);
  const now = Date.now();
  if (now < from) throw new Error(`${BRIEF_DATE} 브리프의 수집 구간이 아직 시작되지 않았습니다.`);
  const end = Math.min(to, now);
  console.log(`${BRIEF_DATE} 브리프 · 수집 구간 ${toKstIso(new Date(from)).slice(5, 16)} ~ ${toKstIso(new Date(end)).slice(5, 16)} (KST)`);
  if (end < to) console.log(`(마감 ${CUTOFF_HOUR_KST}:00 전이라 지금까지 나온 기사만)`);

  const feeds = [
    ...KEYWORDS.map((k) => ({ label: `키워드: ${k}`, url: googleNewsUrl(k), kind: "google" })),
    ...PUBLISHER_FEEDS.map(([name, url]) => ({ label: name, source: name, url, kind: "publisher" })),
  ];
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f.url)));
  if (results.every((r) => r.status === "rejected")) {
    // 기사가 0건인 것과 네트워크가 막힌 것을 구분한다 (예약 작업이 '성공'으로 끝나지 않게)
    throw new Error(`모든 피드 수집 실패 — 네트워크 접근을 확인하세요. (${results[0].reason?.cause?.message || results[0].reason?.message})`);
  }

  // 앞선 실행에서 이미 고른 후보는 출처별 상한에 다시 걸리지 않게 표시해 둔다
  const pool = existing.map((e) => ({ ...e, publishedAt: new Date(e.publishedAt), prior: true }));
  results.forEach((r, i) => {
    const feed = feeds[i];
    if (r.status === "rejected") {
      console.warn(`⚠️  ${feed.label} 수집 실패: ${r.reason?.message || r.reason}`);
      return;
    }
    const inWindow = r.value.items
      .map((raw) => toItem(raw, feed))
      .filter((it) => it.title && it.link && it.publishedAt)
      .filter((it) => it.publishedAt.getTime() >= from && it.publishedAt.getTime() < end);
    const ok = inWindow.filter((it) =>
      feed.kind === "google" ? CORE_TERMS.test(it.title) && !SPAM_TERMS.test(it.title) : isRelevantPublisher(it.title, it.description)
    );
    console.log(`✓ ${feed.label}: 구간 내 ${inWindow.length}건 → 관련 ${ok.length}건`);
    pool.push(...ok);
  });

  const items = select(pool);
  const withLead = items.filter((i) => i.description).length;
  console.log(`후보 ${items.length}건 (리드 있음 ${withLead}건)`);
  return { items, window: { from: toKstIso(new Date(from)), to: toKstIso(new Date(end)) } };
}

// ───────── 2. 요약·분류 규칙 ─────────
// 예약 작업(Claude)이 직접 요약할 때도, API로 요약할 때도 이 규칙을 그대로 쓴다.
const EDITORIAL_RULES = `독자: 결제·PG·정산 서비스를 만드는 회사의 상품기획자. 출근 전에 5분 안에 읽는다.

[category] payment(결제·PG·간편결제) | settlement(정산·송금·외환) | ai_agent(AI·에이전트 결제) | regulation(규제·정책·당국) | market(경쟁사·투자·시장) 중 하나

[summary] 문장 배열
- 리드(설명)가 있으면 2~3문장, 없으면 제목으로 알 수 있는 사실만 1문장.
- 누가 / 무엇을 / 언제·얼마나를 구체적으로. 회사명·서비스명·숫자를 살린다.
- 기사 문장을 그대로 옮기지 말고 자기 말로 다시 쓴다. 각 문장 60자 이내, "~다."로 끝낸다.
- 리드·제목에 없는 사실은 쓰지 않는다. 추측은 summary가 아니라 insight에서만, "~일 수 있다"로.

[insight] 상품기획자가 오늘 할 일 또는 던질 질문 1문장 (70자 이내)
- 이 기사 때문에 무엇을 확인·비교·준비해야 하는지 구체적으로 쓴다.
- 나쁜 예: "관련 수요를 확인할 필요." / "동향을 지켜볼 필요."
- 좋은 예: "토스·카카오페이와 본인확인 단계 수를 비교해 가입 이탈 구간을 점검." / "원화 스테이블코인 정산 시 가맹점 수수료 구조가 어떻게 바뀔지 시나리오 정리."

[importance] 1~3 정수
- 3: 규제·제도 변화, 대형 사업자의 신규 결제 서비스 출시, 시장 구조를 바꾸는 사건 (하루 0~3건)
- 2: 경쟁사 기능 업데이트, 제휴, 투자 유치, 실적
- 1: 행사·시상·인사·단신·홍보성 기사

[relevant] true/false
- 결제·송금·정산·핀테크 서비스나 그 규제와 직접 관련이 없으면 false
  (일반 증시·투자·코인 시세·보안·부동산 기사, 쇼핑 할인 홍보 글 등)`;

const OVERVIEW_RULES = `[_overview] 오늘 브리프 전체를 보고 쓴다.
- headline: 오늘 흐름을 한 문장으로 (35자 이내, 마침표 없이). 예: "원화 스테이블코인, 결제 실사용 논의로 넘어간다"
- points: 3개. 각 60자 이내 문장. 가능하면 기사 여러 건을 묶은 흐름으로 쓰고, 단일 기사 요약을 반복하지 않는다.`;

function buildPrompt({ title, source, description }) {
  return `너는 결제·핀테크 뉴스레터의 에디터다. 아래 기사 제목과 리드(설명)만 보고 답하라.

${EDITORIAL_RULES}

[제목] ${title}
[출처] ${source}
[리드] ${description || "(없음)"}

JSON으로만 답하라: {"category", "summary": [...], "insight", "importance", "relevant"}`;
}

function buildOverviewPrompt(items) {
  const list = items
    .map((i) => `- (${i.category}, 중요도 ${i.importance}) ${i.title} — ${i.summary.join(" ")}`)
    .join("\n");
  return `너는 결제·핀테크 뉴스레터의 에디터다. 오늘 브리프에 실린 기사들이다.\n\n${list}\n\n${OVERVIEW_RULES}\n\nJSON으로만 답하라: {"headline", "points": [...]}`;
}

let client, outputFormat, overviewFormat;
async function initClient() {
  const Anthropic = require("@anthropic-ai/sdk");
  const { z } = require("zod");
  const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");
  client = new Anthropic(); // ANTHROPIC_API_KEY 환경 변수 사용
  outputFormat = zodOutputFormat(
    z.object({
      category: z.enum(CATEGORIES),
      summary: z.array(z.string()),
      insight: z.string(),
      importance: z.number().int(),
      relevant: z.boolean(),
    })
  );
  overviewFormat = zodOutputFormat(z.object({ headline: z.string(), points: z.array(z.string()) }));
}

async function ask(prompt, format) {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format },
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("모델이 응답을 거절함");
  if (!res.parsed_output) throw new Error(`JSON 파싱 실패 (stop_reason=${res.stop_reason})`);
  return res.parsed_output;
}

async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    })
  );
  return out;
}

// ───────── 3. 검증·저장 ─────────
function checkSummary(s) {
  const problems = [];
  if (!CATEGORIES.includes(s.category)) problems.push(`category=${s.category}`);
  if (!Array.isArray(s.summary) || !s.summary.length || s.summary.length > 3) problems.push("summary 1~3문장 아님");
  if (typeof s.insight !== "string" || !s.insight.trim()) problems.push("insight 없음");
  if (![1, 2, 3].includes(s.importance)) problems.push(`importance=${s.importance}`);
  return problems;
}
function checkOverview(o) {
  if (!o) return ["_overview 없음"];
  const p = [];
  if (typeof o.headline !== "string" || !o.headline.trim()) p.push("headline 없음");
  if (!Array.isArray(o.points) || o.points.length < 2 || o.points.length > 4) p.push("points 2~4개 아님");
  return p;
}

function save({ items, overview, generatedAt, date, window }) {
  const top3 = [...items]
    .sort((a, b) => b.importance - a.importance || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 3)
    .map((i) => i.id);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${date}.json`);
  const body = { date, window, generatedAt: toKstIso(generatedAt), overview, top3, items };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");

  const dates = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse();
  fs.writeFileSync(path.join(DATA_DIR, "index.json"), JSON.stringify({ dates }, null, 2) + "\n");
  return file;
}

const publicItem = (c, s) => ({
  id: c.id,
  title: c.title,
  source: c.source,
  publishedAt: typeof c.publishedAt === "string" ? c.publishedAt : toKstIso(c.publishedAt),
  link: c.link,
  category: s.category,
  summary: s.summary.map((x) => String(x).trim()).filter(Boolean),
  insight: s.insight.trim(),
  importance: s.importance,
});

/**
 * API 키 없이 쓰는 방식 (Claude Code 예약 작업용)
 *   1) GitHub Actions가 candidates/YYYY-MM-DD.json 에 후보를 누적
 *   2) Claude가 EDITORIAL_RULES·OVERVIEW_RULES대로 summaries.json 작성:
 *      { "<id>": { category, summary[], insight, importance, relevant }, ..., "_overview": { headline, points[] } }
 *   3) --assemble 로 검증 후 data/ 저장
 */
function assemble(candFile, sumFile) {
  const candJson = JSON.parse(fs.readFileSync(candFile, "utf8"));
  if (!candJson.date || !candJson.window) throw new Error("후보 파일에 date/window가 없습니다.");
  const sums = JSON.parse(fs.readFileSync(sumFile, "utf8"));
  const items = [];
  let bad = 0;
  for (const c of candJson.items) {
    const s = sums[c.id];
    if (!s) {
      console.warn(`  요약 없음: ${c.title.slice(0, 40)}`);
      bad++;
      continue;
    }
    if (s.relevant === false) {
      console.log(`  제외: ${c.title.slice(0, 40)}`);
      continue;
    }
    const problems = checkSummary(s);
    if (problems.length) {
      console.warn(`  형식 오류: ${c.title.slice(0, 40)} — ${problems.join(", ")}`);
      bad++;
      continue;
    }
    items.push(publicItem(c, s));
  }
  const ovProblems = checkOverview(sums._overview);
  if (ovProblems.length) console.warn(`  오늘의 흐름: ${ovProblems.join(", ")}`);
  if (bad || ovProblems.length) throw new Error(`요약 파일에 고칠 곳이 있습니다 (기사 ${bad}건, 흐름 ${ovProblems.length}건). 고친 뒤 다시 실행하세요.`);
  if (!items.length) throw new Error("저장할 기사가 없습니다.");
  const overview = { headline: sums._overview.headline.trim(), points: sums._overview.points.map((p) => p.trim()) };
  const file = save({ items, overview, generatedAt: new Date(), date: candJson.date, window: candJson.window });
  console.log(`저장: ${path.relative(ROOT, file)} (${items.length}/${candJson.items.length}건)`);
}

// ───────── 실행 ─────────
async function main() {
  if (args.includes("--assemble")) {
    assemble(argVal("--candidates"), argVal("--assemble"));
    return;
  }

  const candOut = argVal("--candidates");
  let existing = [];
  if (candOut && MERGE && fs.existsSync(candOut)) {
    const prev = JSON.parse(fs.readFileSync(candOut, "utf8"));
    if (prev.date === BRIEF_DATE) existing = prev.items;
    console.log(`기존 후보 ${existing.length}건에 누적`);
  } else if (!candOut) {
    // API로 한 번에 만들 때도 그날 누적된 후보를 함께 쓴다
    const pooled = path.join(ROOT, "candidates", `${BRIEF_DATE}.json`);
    if (fs.existsSync(pooled)) existing = JSON.parse(fs.readFileSync(pooled, "utf8")).items || [];
  }
  const { items: collected, window } = await collect(existing);

  if (candOut) {
    fs.mkdirSync(path.dirname(path.resolve(candOut)), { recursive: true });
    const items = collected.map((it) => ({
      id: it.id,
      title: it.title,
      source: it.source,
      description: it.description,
      link: it.link,
      publishedAt: toKstIso(it.publishedAt),
      feed: it.feed,
    }));
    fs.writeFileSync(candOut, JSON.stringify({ date: BRIEF_DATE, window, rules: EDITORIAL_RULES, overviewRules: OVERVIEW_RULES, items }, null, 2) + "\n");
    console.log(`후보 저장: ${candOut} (${items.length}건)`);
    return;
  }

  if (COLLECT_ONLY) {
    collected.forEach((it, i) =>
      console.log(`${String(i + 1).padStart(2)}. [${toKstIso(it.publishedAt).slice(5, 16).replace("T", " ")}] ${it.title} — ${it.source}${it.description ? `\n    리드: ${it.description.slice(0, 80)}` : ""}`)
    );
    return;
  }

  if (!collected.length) {
    console.error("수집된 기사가 없어 저장하지 않습니다.");
    process.exitCode = 1;
    return;
  }

  await initClient();
  const startedAt = new Date();
  const targets = LIMIT ? collected.slice(0, LIMIT) : collected;
  const done = await mapLimit(targets, CONCURRENCY, async (it, i) => {
    try {
      const s = await ask(buildPrompt(it), outputFormat);
      s.importance = Math.min(3, Math.max(1, s.importance));
      s.summary = s.summary.slice(0, 3);
      if (!s.relevant) return null;
      console.log(`  ${i + 1}/${targets.length} ✓ [${s.category}·${s.importance}] ${it.title.slice(0, 40)}`);
      return publicItem(it, s);
    } catch (e) {
      console.warn(`  ${i + 1}/${targets.length} ✗ ${it.title.slice(0, 40)} — ${e.message}`);
      return null;
    }
  });
  const items = done.filter(Boolean);
  if (!items.length) {
    console.error("요약에 모두 실패해 저장하지 않습니다.");
    process.exitCode = 1;
    return;
  }
  const ov = await ask(buildOverviewPrompt(items), overviewFormat);
  const file = save({ items, overview: { headline: ov.headline, points: ov.points.slice(0, 3) }, generatedAt: startedAt, date: BRIEF_DATE, window });
  console.log(`\n저장: ${path.relative(ROOT, file)} (${items.length}건)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
