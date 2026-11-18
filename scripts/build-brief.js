#!/usr/bin/env node
/**
 * Pay Brief — 결제·핀테크 뉴스 수집 → 중복 제거 → LLM 요약·분류 → data/YYYY-MM-DD.json
 *
 * 사용법
 *   node scripts/build-brief.js                 # 전체 실행 (최대 30건 요약 + 저장)
 *   node scripts/build-brief.js --collect-only  # 수집·중복 제거만, 콘솔 출력 (API 키 불필요)
 *   node scripts/build-brief.js --limit 3       # 앞에서 3건만 요약해 저장 (품질 확인용)
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

// 보조 출처. 세계파이낸스(https://www.segyefn.com/views/rss/finance.xml)는
// 2026-11-18 확인 시 HTTPS 인증서 불일치 + HTTP DNS 실패로 응답이 없어 제외함.
const EXTRA_FEEDS = [];

const MAX_TOTAL = 30;
const PER_KEYWORD = 6;
const WINDOW_HOURS = 24;
const MODEL = "claude-haiku-5-5";
const CONCURRENCY = 4;
const CATEGORIES = ["payment", "settlement", "ai_agent", "regulation", "market"];

// 관련성 1차 필터 (제목 기준). Google 뉴스 검색은 키워드 일부만 맞아도 걸려 오므로
// 결제 핵심어가 하나도 없거나 광고성 단어가 있으면 수집 단계에서 뺀다.
const CORE_TERMS =
  /결제|페이|pay|PG|정산|송금|카드|스테이블코인|핀테크|간편|수수료|가맹점|지갑|월렛|wallet|환전|외환|선불|후불|BNPL|전자금융|지급|빌링|이체|계좌|토스|머니/i;
const SPAM_TERMS = /할인코드|쿠폰|프로모션 ?코드|추천인|이벤트 응모|최저가/;
const isRelevantTitle = (t) => CORE_TERMS.test(t) && !SPAM_TERMS.test(t);

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

// ───────── 유틸 ─────────
const args = process.argv.slice(2);
const COLLECT_ONLY = args.includes("--collect-only");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;

/** Date → "2026-11-18T07:00:12+09:00" */
function toKstIso(d) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return k.toISOString().replace(/\.\d{3}Z$/, "+09:00");
}
const kstDate = (d) => toKstIso(d).slice(0, 10);

function stripHtml(s = "") {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLink(link) {
  try {
    const u = new URL(link);
    u.hash = "";
    // 추적용 쿼리 제거 (Google 뉴스 ?oc=5, utm_* 등)
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
/** 제목 바이그램(공백·특수문자 제거 후 2글자씩) */
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

// ───────── 1. 수집 ─────────
const parser = new Parser({ customFields: { item: ["source"] } });

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (PayBrief RSS reader)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parser.parseString(await res.text());
}

function toItem(raw, fallbackSource) {
  // Google 뉴스: <source>언론사</source>, 제목 끝에 " - 언론사"가 붙음
  const src =
    (typeof raw.source === "string" ? raw.source : raw.source?._) || fallbackSource || "";
  let title = (raw.title || "").trim();
  if (src && title.endsWith(` - ${src}`)) title = title.slice(0, -(src.length + 3)).trim();
  // 일부 언론사는 이름 대신 주소로 옴 → 도메인만 표시 (예: https://www.thedailyeconomy.kr/ → thedailyeconomy.kr)
  let source = src;
  if (/^https?:\/\//i.test(src)) {
    try {
      source = new URL(src).hostname.replace(/^www\./, "");
    } catch {}
  }
  let description = stripHtml(raw.contentSnippet || raw.content || raw.description || "");
  // Google 뉴스 설명은 대개 "제목 언론사" 반복 → 그대로면 비워 둔다
  const descKey = titleKey(description.replace(src, ""));
  if (descKey && descKey === titleKey(title)) description = "";
  const published = raw.isoDate ? new Date(raw.isoDate) : null;
  return {
    title,
    source,
    description,
    link: raw.link,
    publishedAt: published,
  };
}

async function collect() {
  const now = Date.now();
  const cutoff = now - WINDOW_HOURS * 3600 * 1000;
  const feeds = [
    ...KEYWORDS.map((k) => ({ label: `키워드: ${k}`, url: googleNewsUrl(k) })),
    ...EXTRA_FEEDS,
  ];

  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f.url)));

  // 모든 피드 후보를 모아 최신순 정렬 → 중복이면 최신 1건만 남김
  const candidates = [];
  results.forEach((r, i) => {
    const feed = feeds[i];
    if (r.status === "rejected") {
      console.warn(`⚠️  ${feed.label} 수집 실패: ${r.reason?.message || r.reason}`);
      return;
    }
    const items = r.value.items
      .map((raw) => toItem(raw, feed.source))
      .filter((it) => it.title && it.link && it.publishedAt)
      .filter((it) => it.publishedAt.getTime() >= cutoff && it.publishedAt.getTime() <= now + 3600e3);
    const relevant = items.filter((it) => isRelevantTitle(it.title));
    console.log(`✓ ${feed.label}: 최근 ${WINDOW_HOURS}h ${items.length}건 (무관 ${items.length - relevant.length}건 제외)`);
    items.length = 0;
    items.push(...relevant);
    for (const it of items) candidates.push({ ...it, feed: feed.label });
  });
  candidates.sort((a, b) => b.publishedAt - a.publishedAt);

  const seenLinks = new Set();
  const seenTitles = new Set();
  const kept = [];
  const perFeed = {};
  let dupes = 0;
  for (const it of candidates) {
    const nl = normalizeLink(it.link);
    const tk = titleKey(it.title);
    const c = { ...it, id: sha1(nl), bg: bigrams(it.title), lead: leadSubject(it.title) };
    if (seenLinks.has(nl)) continue; // 같은 기사가 여러 키워드에 걸림
    if (seenTitles.has(tk) || kept.some((k) => isSameStory(k, c))) {
      dupes++;
      seenLinks.add(nl);
      continue;
    }
    seenLinks.add(nl);
    seenTitles.add(tk);
    if ((perFeed[it.feed] || 0) >= PER_KEYWORD) continue;
    perFeed[it.feed] = (perFeed[it.feed] || 0) + 1;
    kept.push(c);
  }
  console.log(`유사 제목 중복 ${dupes}건 제거`);
  const picked = kept.map(({ bg, lead, ...rest }) => rest);

  return picked.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_TOTAL);
}

// ───────── 2. 요약·분류 ─────────
function buildPrompt({ title, source, description }) {
  return `너는 결제·핀테크 회사 상품기획팀을 돕는 리서치 어시스턴트다.
아래 기사 제목과 설명만 보고 답하라. 설명에 없는 사실은 지어내지 마라.

[제목] ${title}
[출처] ${source}
[설명] ${description || "(설명 없음)"}

다음 JSON 형식으로만 답하라.
{
  "category": "payment | settlement | ai_agent | regulation | market 중 하나",
  "summary": ["요약 1문장", "요약 2문장", "요약 3문장"],
  "insight": "상품기획팀이 검토할 점 1문장 (예: ~ 기능의 수요를 확인할 필요)",
  "importance": 1~3 (3이 가장 중요),
  "relevant": true 또는 false
}

규칙:
- 요약은 기사 문장을 그대로 옮기지 말고 너의 말로 쓴다. 각 문장 40자 이내.
- 설명이 너무 짧아 판단이 어려우면 summary를 1문장만 쓰고 importance는 1로 둔다.
- 결제·송금·정산·핀테크 서비스나 그 규제와 직접 관련이 없는 기사(일반 AI·투자·증권·보안 기사, 쇼핑 할인·쿠폰 홍보 글 등)는 relevant를 false로 둔다.`;
}

let client, outputFormat;
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
}

async function summarize(item) {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: outputFormat },
    messages: [{ role: "user", content: buildPrompt(item) }],
  });
  if (res.stop_reason === "refusal") throw new Error("모델이 응답을 거절함");
  const out = res.parsed_output;
  if (!out) throw new Error(`JSON 파싱 실패 (stop_reason=${res.stop_reason})`);
  return {
    category: out.category,
    summary: out.summary.map((s) => s.trim()).filter(Boolean).slice(0, 3),
    insight: out.insight.trim(),
    importance: Math.min(3, Math.max(1, out.importance)),
    relevant: out.relevant,
  };
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

// ───────── 3. 저장 ─────────
function save(items, generatedAt) {
  const date = kstDate(generatedAt);
  const top3 = [...items]
    .sort((a, b) => b.importance - a.importance || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 3)
    .map((i) => i.id);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${date}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ date, generatedAt: toKstIso(generatedAt), top3, items }, null, 2) + "\n"
  );

  const dates = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse();
  fs.writeFileSync(path.join(DATA_DIR, "index.json"), JSON.stringify({ dates }, null, 2) + "\n");
  return file;
}

// ───────── 실행 ─────────
/**
 * API 키 없이 쓰는 2단계 방식 (Claude Code 예약 작업용)
 *   1) node scripts/build-brief.js --candidates work/candidates.json
 *      → 수집·중복 제거 결과를 파일로 저장
 *   2) Claude가 work/summaries.json 작성: { "<id>": { category, summary[], insight, importance }, ... }
 *      (요약 규칙은 buildPrompt()와 동일)
 *   3) node scripts/build-brief.js --assemble work/summaries.json --candidates work/candidates.json
 *      → 검증 후 data/YYYY-MM-DD.json, data/index.json 저장
 */
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

function assemble(candFile, sumFile) {
  const cands = JSON.parse(fs.readFileSync(candFile, "utf8")).items;
  const sums = JSON.parse(fs.readFileSync(sumFile, "utf8"));
  const items = [];
  for (const c of cands) {
    const s = sums[c.id];
    if (!s) {
      console.warn(`  요약 없음, 건너뜀: ${c.title.slice(0, 40)}`);
      continue;
    }
    if (s.relevant === false) {
      console.log(`  관련 없음, 제외: ${c.title.slice(0, 40)}`);
      continue;
    }
    const problems = [];
    if (!CATEGORIES.includes(s.category)) problems.push(`category=${s.category}`);
    if (!Array.isArray(s.summary) || !s.summary.length || s.summary.length > 3) problems.push("summary 1~3문장 아님");
    if (typeof s.insight !== "string" || !s.insight.trim()) problems.push("insight 없음");
    if (![1, 2, 3].includes(s.importance)) problems.push(`importance=${s.importance}`);
    if (problems.length) {
      console.warn(`  형식 오류, 건너뜀: ${c.title.slice(0, 40)} — ${problems.join(", ")}`);
      continue;
    }
    items.push({
      id: c.id,
      title: c.title,
      source: c.source,
      publishedAt: c.publishedAt,
      link: c.link,
      category: s.category,
      summary: s.summary.map((x) => String(x).trim()).filter(Boolean),
      insight: s.insight.trim(),
      importance: s.importance,
    });
  }
  if (!items.length) throw new Error("저장할 기사가 없습니다.");
  const file = save(items, new Date());
  console.log(`저장: ${path.relative(ROOT, file)} (${items.length}/${cands.length}건)`);
}

async function main() {
  const startedAt = new Date();

  if (args.includes("--assemble")) {
    assemble(argVal("--candidates"), argVal("--assemble"));
    return;
  }

  const collected = await collect();
  console.log(`\n총 ${collected.length}건 (중복 제거 후)\n`);

  const candOut = argVal("--candidates");
  if (candOut) {
    fs.mkdirSync(path.dirname(path.resolve(candOut)), { recursive: true });
    const items = collected.map((it) => ({
      id: it.id,
      title: it.title,
      source: it.source,
      description: it.description,
      link: it.link,
      publishedAt: toKstIso(it.publishedAt),
    }));
    fs.writeFileSync(candOut, JSON.stringify({ prompt: buildPrompt({ title: "{title}", source: "{source}", description: "{description}" }), items }, null, 2) + "\n");
    console.log(`후보 저장: ${candOut} (${items.length}건)`);
    return;
  }

  if (COLLECT_ONLY) {
    collected.forEach((it, i) =>
      console.log(
        `${String(i + 1).padStart(2)}. [${toKstIso(it.publishedAt).slice(5, 16).replace("T", " ")}] ${it.title} — ${it.source}${it.description ? `\n    설명: ${it.description.slice(0, 80)}` : ""}`
      )
    );
    return;
  }

  if (!collected.length) {
    console.error("수집된 기사가 없어 저장하지 않습니다.");
    process.exitCode = 1;
    return;
  }

  await initClient();
  const targets = LIMIT ? collected.slice(0, LIMIT) : collected;
  let failed = 0;
  const done = await mapLimit(targets, CONCURRENCY, async (it, i) => {
    try {
      const { relevant, ...s } = await summarize(it);
      if (!relevant) {
        console.log(`  ${i + 1}/${targets.length} – 관련 없음, 제외: ${it.title.slice(0, 40)}`);
        return null;
      }
      console.log(`  ${i + 1}/${targets.length} ✓ [${s.category}·${s.importance}] ${it.title.slice(0, 40)}`);
      return {
        id: it.id,
        title: it.title,
        source: it.source,
        publishedAt: toKstIso(it.publishedAt),
        link: it.link,
        ...s,
      };
    } catch (e) {
      failed++;
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
  const file = save(items, startedAt);
  console.log(`\n저장: ${path.relative(ROOT, file)} (${items.length}건, 실패 ${failed}건)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
