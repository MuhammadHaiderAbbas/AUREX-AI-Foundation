/**
 * Browser port of backend/app/research (text, classify, chunking, hashing embedder,
 * hybrid retrieval and the offline extractive report) for the static GitHub Pages demo.
 * The Claude engine and PDF extraction exist only in the backend.
 */
import { fnv1a } from "./market";

const STOP = new Set(`a about above after again against all am an and any are as at be because been before being below
between both but by can could did do does doing down during each few for from further had has have having he her here
hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once
only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then
there these they this those through to too under until up very was we were what when where which while who whom why will
with would you your yours yourself yourselves also its per via what's s t`.split(/\s+/));
const SUFFIXES = ["ations", "ation", "ings", "ing", "edly", "ed", "ies", "es", "ly", "s"];

export function normalise(t: string) {
  return t.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
export const squash = (t: string) => normalise(t).replace(/\s+/g, " ").trim().toLowerCase();
function stem(t: string) {
  if (/^\d+$/.test(t) || t.length <= 4) return t;
  for (const s of SUFFIXES) if (t.endsWith(s) && t.length - s.length >= 3) return t.slice(0, -s.length);
  return t;
}
export function tokens(text: string, keepStop = false) {
  return (text.toLowerCase().match(/[a-z0-9]+(?:[./][a-z0-9]+)*/g) ?? []).filter((t) => keepStop || !STOP.has(t)).map(stem);
}
export function sentences(text: string) {
  return text.split(/\n\s*\n/).flatMap((p) => p.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/)).map((s) => s.trim()).filter(Boolean);
}
export function htmlToText(html: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template,svg,nav,footer,form").forEach((n) => n.remove());
  doc.querySelectorAll("p,div,br,li,h1,h2,h3,h4,h5,h6,tr,section,article,blockquote,pre").forEach((n) => n.append("\n\n"));
  const text = (doc.body?.textContent ?? "").split(/\n\s*\n/).map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");
  return { title: normalise(doc.title ?? ""), text: normalise(text) };
}

// ---- classify ---------------------------------------------------------------------
export const DOC_TYPES = ["earnings", "filing", "central_bank", "economic_data", "news", "analysis", "other"];
const RULES: [string, string[]][] = [
  ["central_bank", ["monetary policy", "policy rate", "rate decision", "central bank", "basis points", "policy committee", "interest rate decision"]],
  ["earnings", ["quarterly results", "third-quarter", "second-quarter", "first-quarter", "fourth-quarter", "earnings per share", "revenue", "guidance", "fiscal year results"]],
  ["filing", ["form 10-k", "form 10-q", "form 8-k", "annual report", "companies house", "securities and exchange commission", "pursuant to"]],
  ["economic_data", ["unemployment rate", "inflation rate", "consumer price index", "cpi", "payrolls", "gdp", "labour market", "labor market", "pmi"]],
  ["analysis", ["analyst", "price target", "we expect", "our view", "outlook", "research note"]],
];
export const STALE_AFTER: Record<string, number> = { news: 7, analysis: 30, economic_data: 45, central_bank: 60, earnings: 120, filing: 400, other: 365 };
const POS = new Set(tokens("beat beats beating growth grew grow increase increased rise rose rising strong stronger strength improve improved improvement record raised raise upgrade upgraded outperform gain gains expansion expanded robust surge surged accelerate accelerated positive supported support resilient exceed exceeded exceeding rebound recovered recovery optimistic higher profitable profit tailwind inflows", true));
const NEG = new Set(tokens("miss missed misses decline declined declining fall fell falling weak weaker weakness loss losses downgrade downgraded risk risks concern concerns slowdown slowing slowed contraction deteriorate deteriorated deterioration pressure pressures volatility uncertainty default lawsuit warn warned warning lower lowered headwind headwinds outflows disappointing shortfall cautious elevated build-up buildup", true));
const NEGATORS = new Set(["not", "no", "never", "without", "neither"]);

export function classify(title: string, text: string) {
  const hay = `${title}\n${text.slice(0, 6000)}`.toLowerCase();
  let best = "news", hits = 0;
  for (const [type, cues] of RULES) {
    const h = cues.reduce((a, c) => a + hay.split(c).length - 1, 0);
    if (h > hits) { best = type; hits = h; }
  }
  return best;
}
export function sentiment(text: string) {
  let pos = 0, neg = 0, flip = 0;
  for (const tok of text.toLowerCase().match(/[a-z0-9-]+|[.,;:!?]/g) ?? []) {
    if (/^[.,;:!?]$/.test(tok)) { flip = 0; continue; }
    if (NEGATORS.has(tok)) { flip = 3; continue; }
    const t = tokens(tok, true)[0] ?? tok;
    let p = POS.has(t), n = NEG.has(t);
    if (flip) { if (p || n) { [p, n] = [n, p]; flip = 0; } else flip--; }
    pos += +p; neg += +n;
  }
  return Math.round(((pos - neg) / (pos + neg + 1)) * 1e4) / 1e4;
}
export function tagInstruments(text: string, aliases: Record<string, string[]>) {
  const found: string[] = [];
  for (const [sym, names] of Object.entries(aliases)) {
    if (names.some((n) => new RegExp(`(?<![A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![A-Za-z0-9])`, n.length <= 4 ? "" : "i").test(text))) found.push(sym);
  }
  return found.sort();
}

// ---- chunking & embeddings -------------------------------------------------------------
export function chunk(text: string) {
  const out: { ordinal: number; text: string; paragraph: number }[] = [];
  let buf: string[] = [], size = 0, para = 0, bufPara = 0;
  const flush = () => { if (buf.length) out.push({ ordinal: out.length, text: buf.join("\n\n"), paragraph: bufPara || 1 }); buf = []; size = 0; bufPara = 0; };
  for (const raw of text.split(/\n\s*\n/)) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (!p) continue;
    para++;
    if (size && size + p.length > 900) flush();
    if (!bufPara) bufPara = para;
    buf.push(p); size += p.length + 2;
  }
  flush();
  return out;
}
export function embed(text: string): number[] {
  const vec = new Array(384).fill(0);
  const toks = tokens(text);
  const feats = new Map<string, number>();
  toks.forEach((t, i) => {
    feats.set(t, (feats.get(t) ?? 0) + 1);
    if (i + 1 < toks.length) feats.set(`${t}_${toks[i + 1]}`, (feats.get(`${t}_${toks[i + 1]}`) ?? 0) + 0.5);
  });
  for (const [f, tf] of feats) {
    const h = fnv1a(f);
    vec[h % 384] += ((h >>> 31) & 1 ? 1 : -1) * (1 + Math.log(tf));
  }
  const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}
const cosine = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);

// ---- corpus types -----------------------------------------------------------------------
export interface DDoc {
  id: string; title: string; source_name: string; source_url: string | null; doc_type: string; content_type: string;
  published_at: string | null; retrieved_at: string; content_hash: string; word_count: number; page_count: number | null;
  symbols: string[]; sentiment: number; is_sample: boolean;
}
export interface DChunk { id: string; document_id: string; ordinal: number; text: string; page: number | null; paragraph: number; sentiment: number; embedding: number[] }
export interface Evidence { chunk: DChunk; doc: DDoc; score: number }

const DAY = 86_400_000;
const ageDays = (d: DDoc, now: number) => (d.published_at ? Math.max(0, Math.floor((now - Date.parse(d.published_at)) / DAY)) : null);
const isStale = (d: DDoc, now: number) => { const a = ageDays(d, now); return a != null && a > (STALE_AFTER[d.doc_type] ?? 365); };

export function search(docs: DDoc[], chunks: DChunk[], query: string, k = 8, symbols?: string[], maxAgeDays?: number): Evidence[] {
  const terms = new Set(tokens(query));
  if (!terms.size) return [];
  const now = Date.now();
  const byId = new Map(docs.map((d) => [d.id, d]));
  const pool = chunks.filter((c) => {
    const d = byId.get(c.document_id)!;
    if (symbols?.length && !d.symbols.some((s) => symbols.includes(s))) return false;
    if (maxAgeDays && (!d.published_at || now - Date.parse(d.published_at) > maxAgeDays * DAY)) return false;
    return true;
  });
  const q = embed(query);
  const sem = pool.map((c) => ({ c, s: cosine(q, c.embedding) })).filter((x) => x.s > 0.05).sort((a, b) => b.s - a.s).slice(0, 40);
  const lex = pool.map((c) => {
    const ct = tokens(c.text);
    return { c, s: ct.filter((t) => terms.has(t)).length / Math.sqrt(ct.length || 1) };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40);
  const fused = new Map<string, number>();
  sem.forEach((x, r) => fused.set(x.c.id, (fused.get(x.c.id) ?? 0) + 1 / (60 + r)));
  lex.forEach((x, r) => fused.set(x.c.id, (fused.get(x.c.id) ?? 0) + 1 / (60 + r)));
  const byChunk = new Map(pool.map((c) => [c.id, c]));
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([id, s]) => ({ chunk: byChunk.get(id)!, doc: byId.get(byChunk.get(id)!.document_id)!, score: Math.round(s * 1e6) / 1e3 }));
}

// ---- extractive report (mirror of app/research/reports.py) ------------------------------
interface Claim { statement: string; citations: number[]; quote: string; verified: true }
export function report(question: string, ev: Evidence[]) {
  const now = Date.now();
  const q = new Set(tokens(question));
  const scored: [number, number, string][] = [];
  ev.forEach((e, i) => {
    for (const s of sentences(e.chunk.text)) {
      const st = new Set(tokens(s));
      const overlap = [...st].filter((t) => q.has(t)).length;
      if (!st.size || !overlap) continue;
      scored.push([overlap / Math.sqrt(st.size) + (/\d/.test(s) ? 0.35 : 0) + 0.5 / (i + 1), i + 1, s]);
    }
  });
  scored.sort((a, b) => b[0] - a[0]);
  const facts: Claim[] = [];
  const perDoc = new Map<string, number>();
  const seen: Set<string>[] = [];
  for (const [, n, s] of scored) {
    const doc = ev[n - 1]!.doc.id;
    const st = new Set(tokens(s));
    const jac = (o: Set<string>) => [...st].filter((t) => o.has(t)).length / new Set([...st, ...o]).size;
    if ((perDoc.get(doc) ?? 0) >= 2 || seen.some((o) => jac(o) > 0.6)) continue;
    facts.push({ statement: s, citations: [n], quote: s, verified: true });
    perDoc.set(doc, (perDoc.get(doc) ?? 0) + 1); seen.push(st);
    if (facts.length === 6) break;
  }
  const insufficient = !ev.length || ev[0]!.score < 16 || !facts.length;
  const cited = [...new Set(facts.flatMap((f) => f.citations))].sort((a, b) => a - b);
  const tone = (n: number) => ev[n - 1]!.chunk.sentiment;
  const pos = cited.filter((n) => tone(n) >= 0.15), neg = cited.filter((n) => tone(n) <= -0.15);
  const quoteFor = (n: number) => facts.find((f) => f.citations.includes(n))?.quote ?? "";
  const contradictions: Claim[] = [];
  if (!insufficient && pos.length && neg.length) {
    if (pos.length === neg.length) {
      for (const n of [...pos, ...neg]) contradictions.push({ statement: `Source [${n}] reads ${pos.includes(n) ? "positive" : "negative"}, while ${(pos.includes(n) ? neg : pos).map((j) => `[${j}]`).join(", ")} reads the other way.`, citations: [n], quote: quoteFor(n), verified: true });
    } else {
      for (const n of pos.length > neg.length ? neg : pos) contradictions.push({ statement: `Source [${n}] reads ${neg.includes(n) ? "negative" : "positive"}, against the balance of the other cited evidence.`, citations: [n], quote: quoteFor(n), verified: true });
    }
  }
  const lean = pos.length > neg.length ? "positive" : neg.length > pos.length ? "negative" : "mixed";
  const interpretation = insufficient ? null : {
    text: pos.length || neg.length
      ? `Automated lexical reading: the cited evidence leans ${lean} (${pos.length} source(s) positive, ${neg.length} negative, ${cited.length - pos.length - neg.length} neutral). This is a word-level tone measure, not an analytical judgement.`
      : "Automated lexical reading: the cited evidence is broadly neutral in tone. This is a word-level tone measure, not an analytical judgement.",
    basis: "system" as const, label: "Interpretation (automated heuristic)",
  };
  // confidence
  const used = cited.length ? cited.map((n) => ev[n - 1]!) : ev.slice(0, 3);
  const docsUsed = new Set(used.map((e) => e.doc.id)).size;
  const evTerms = new Set(tokens(used.map((e) => e.chunk.text).join(" ")));
  const coverage = q.size ? [...q].filter((t) => evTerms.has(t)).length / q.size : 0;
  const fresh = used.length ? used.filter((e) => !isStale(e.doc, now)).length / used.length : 0;
  const signs = used.filter((e) => Math.abs(e.chunk.sentiment) >= 0.15).map((e) => Math.sign(e.chunk.sentiment));
  const agreement = signs.length ? Math.max(signs.filter((s) => s > 0).length, signs.filter((s) => s < 0).length) / signs.length : 1;
  const verified = facts.length ? 1 : 0;
  let score = 0.3 * coverage + 0.25 * Math.min(1, docsUsed / 3) + 0.2 * fresh + 0.15 * agreement + 0.1 * verified;
  if (!facts.length || insufficient) score = Math.min(score, 0.2);
  let label: "low" | "medium" | "high" = score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low";
  if (label === "high" && contradictions.length) label = "medium";
  const r2 = (v: number) => Math.round(v * 100) / 100;

  const sources = ev.map((e, i) => ({
    n: i + 1, document_id: e.doc.id, chunk_id: e.chunk.id, title: e.doc.title, source_name: e.doc.source_name,
    source_url: e.doc.source_url, doc_type: e.doc.doc_type, published_at: e.doc.published_at, retrieved_at: e.doc.retrieved_at,
    page: e.chunk.page, paragraph: e.chunk.paragraph, age_days: ageDays(e.doc, now), stale: isStale(e.doc, now),
    stale_after_days: STALE_AFTER[e.doc.doc_type] ?? 365, is_sample: e.doc.is_sample, relevance: e.score,
    sentiment: e.chunk.sentiment, excerpt: e.chunk.text,
  }));
  const warnings: string[] = [];
  const finalFacts = insufficient ? [] : facts;
  if (insufficient) warnings.push("Insufficient evidence in the research corpus to answer this question.");
  const citedSet = new Set([...finalFacts, ...contradictions].flatMap((f) => f.citations));
  const citedSources = sources.filter((s) => citedSet.has(s.n));
  if (citedSources.length && citedSources.every((s) => s.stale)) warnings.push("Every cited source is older than its staleness threshold.");
  else if (citedSources.some((s) => s.stale)) warnings.push("Some cited sources are stale; check for newer information.");
  if (citedSources.some((s) => s.is_sample)) warnings.push("Cites the fictional sample corpus; not real market information.");
  return {
    question, generated_at: new Date(now).toISOString(), engine: "extractive-v1", insufficient_evidence: insufficient,
    facts: finalFacts, interpretation, contradictions, open_questions: [] as string[],
    confidence: {
      score: r2(score), label,
      factors: { query_coverage: r2(coverage), independent_sources: docsUsed, source_diversity: r2(Math.min(1, docsUsed / 3)), freshness: r2(fresh), agreement: r2(agreement), verified_ratio: verified },
      method: "Heuristic and uncalibrated: weighted evidence coverage, source count, freshness, tonal agreement and citation verification; capped at medium when sources contradict each other. Not a probability.",
    },
    sources,
    validation: { claims_proposed: finalFacts.length + contradictions.length, claims_verified: finalFacts.length + contradictions.length, claims_rejected: 0, rejected: [] },
    warnings,
    disclaimer: "Research output only. It is not investment advice and is never converted into an order automatically.",
  };
}

// ---- fictional sample corpus (mirror of app/research/samples.py) -------------------------
export const SAMPLE_SOURCE = "AUREX sample corpus (fictional)";
export const SAMPLES: [string, string, number, string][] = [
  ["[Sample] Northwind Robotics reports third-quarter results", "earnings", 12, "Northwind Robotics, a fictional industrial automation company, reported third-quarter revenue of 4.2 billion dollars, an increase of 18 percent year on year.\n\nOperating margin improved to 21.5 percent from 18.9 percent a year earlier, driven by higher software subscription revenue and lower component costs.\n\nManagement raised full-year revenue guidance to between 16.4 and 16.8 billion dollars, citing strong order intake in logistics automation.\n\nThe company warned that supply constraints for specialised sensors could limit deliveries in the fourth quarter, and that inventory levels rose to 2.9 billion dollars."],
  ["[Sample] Analyst note: Northwind Robotics inventory build-up raises questions", "analysis", 5, "A research note from a fictional brokerage argues that the inventory build-up at Northwind Robotics is a concern, with inventory days rising to 118 from 96 a year ago.\n\nThe analysts expect slowing order growth in the first half of next year as warehouse customers delay projects, and see downside risk to consensus margin forecasts.\n\nThey acknowledge that software revenue growth remains robust at 31 percent, which partly offsets weaker hardware demand."],
  ["[Sample] Central bank of Fictonia holds policy rate at 4.25 percent", "central_bank", 20, "The monetary policy committee of the fictional Central Bank of Fictonia voted seven to two to hold the policy rate at 4.25 percent.\n\nHeadline inflation eased to 3.1 percent, but services inflation remained elevated at 4.6 percent, according to the committee statement.\n\nTwo members voted for a 25 basis points cut, arguing that the labour market is cooling faster than expected.\n\nThe committee said future decisions would depend on incoming data and that policy would need to remain restrictive for some time."],
  ["[Sample] Fictonia labour market report: unemployment rises to 4.4 percent", "economic_data", 9, "The fictional Fictonia statistics office reported that the unemployment rate rose to 4.4 percent from 4.2 percent in the previous month.\n\nAnnual wage growth slowed to 3.8 percent from 4.3 percent, the weakest pace in two years.\n\nEmployment in manufacturing declined for a third consecutive month, while services employment was broadly flat."],
  ["[Sample] FX desk note: euro supported by narrowing rate differentials", "analysis", 3, "In this fictional scenario written for the AUREX demo, a desk note argues that EUR/USD is supported by narrowing interest rate differentials between the two regions.\n\nThe note expects EUR/USD to trade higher if incoming inflation data continues to ease, but flags elevated volatility around central bank meetings as a key risk.\n\nPositioning data in the scenario shows speculative accounts hold a modest net long euro position."],
  ["[Sample] Crypto weekly: exchange outflows and stablecoin supply", "news", 2, "This is a fictional market commentary for the AUREX demo. It describes Bitcoin (BTC-USD) exchange balances falling for a fourth consecutive week, which the author interprets as reduced selling pressure.\n\nThe commentary notes that stablecoin supply increased by 2 percent over the week, a sign of inflows into digital asset markets in the scenario.\n\nIt also warns that funding rates on derivatives venues have risen, which could signal crowded positioning and higher volatility."],
  ["[Sample] Northwind Robotics annual report extract: risk factors", "filing", 410, "Risk factors (fictional annual report extract). Northwind Robotics depends on a small number of suppliers for specialised sensors; a disruption could materially affect deliveries.\n\nThe company is exposed to currency movements because 46 percent of revenue is earned outside its home market.\n\nCustomer concentration is significant: the five largest customers represented 38 percent of revenue in the fiscal year."],
];
