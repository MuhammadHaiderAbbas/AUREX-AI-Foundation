"""Grounded research reports.

Design rules (from the blueprint):
  * Separate VERIFIED FACTS (verbatim, cited, quote-checked against the source chunk) from
    INTERPRETATION (explicitly labelled as system- or model-generated).
  * Surface CONTRADICTORY evidence instead of hiding it.
  * Confidence is computed by code from evidence properties, never self-reported by a model,
    and is labelled heuristic/uncalibrated.
  * Flag STALE sources. Say "insufficient evidence" rather than guess.
  * A report is research only: it is never converted into an order.
"""

import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.research.classify import STALE_AFTER_DAYS
from app.research.service import Evidence
from app.research.text import sentences, squash, tokens

DISCLAIMER = ("Research output only. It is not investment advice and is never converted "
              "into an order automatically.")
MIN_EVIDENCE_SCORE = 16.0  # an RRF score this low means only one weak signal matched


@dataclass
class Claim:
    statement: str
    source_ids: list[int]
    quote: str


@dataclass
class Draft:
    """What an engine proposes. Validation decides what survives."""

    facts: list[Claim]
    contradictions: list[Claim]
    interpretation: str
    interpretation_basis: str  # "system" | "model"
    open_questions: list[str] = field(default_factory=list)
    answerable: bool = True
    engine: str = "extractive-v1"
    warnings: list[str] = field(default_factory=list)


def source_view(n: int, e: Evidence, now: datetime) -> dict[str, Any]:
    d = e.document
    return {
        "n": n, "document_id": str(d.id), "chunk_id": str(e.chunk.id), "title": d.title,
        "source_name": d.source_name, "source_url": d.source_url, "doc_type": d.doc_type,
        "published_at": d.published_at.isoformat() if d.published_at else None,
        "retrieved_at": d.retrieved_at.isoformat(), "page": e.chunk.page,
        "paragraph": e.chunk.paragraph, "age_days": e.age_days(now), "stale": e.stale(now),
        "stale_after_days": STALE_AFTER_DAYS.get(d.doc_type, 365), "is_sample": d.is_sample,
        "relevance": e.score, "sentiment": e.chunk.sentiment, "excerpt": e.chunk.text,
    }


def _verify(claims: list[Claim], evidence: list[Evidence]) -> tuple[list[dict], list[dict]]:
    """Keep claims whose quote appears verbatim (normalised) in one of their cited chunks."""
    kept, rejected = [], []
    for c in claims:
        ids = [i for i in dict.fromkeys(c.source_ids) if 1 <= i <= len(evidence)]
        quote = squash(c.quote)
        if not ids:
            rejected.append({"statement": c.statement, "reason": "cites no retrieved source"})
        elif len(quote) < 12:
            rejected.append({"statement": c.statement, "reason": "supporting quote too short"})
        elif not any(quote in squash(evidence[i - 1].chunk.text) for i in ids):
            rejected.append({"statement": c.statement,
                             "reason": "quote not found in the cited source"})
        else:
            kept.append({"statement": c.statement.strip(), "citations": ids,
                         "quote": c.quote.strip(), "verified": True})
    return kept, rejected


def confidence(evidence: list[Evidence], facts: list[dict], query: str, now: datetime,
               rejected: int = 0, contested: bool = False) -> dict[str, Any]:
    cited = sorted({i for f in facts for i in f["citations"]})
    used = [evidence[i - 1] for i in cited] or evidence[:3]
    docs = {e.document.id for e in used}
    q_terms = set(tokens(query))
    ev_terms = set(tokens(" ".join(e.chunk.text for e in used)))
    coverage = len(q_terms & ev_terms) / len(q_terms) if q_terms else 0.0
    fresh = sum(not e.stale(now) for e in used) / len(used) if used else 0.0
    signs = [math.copysign(1, e.chunk.sentiment) for e in used if abs(e.chunk.sentiment) >= 0.15]
    agreement = max(signs.count(1), signs.count(-1)) / len(signs) if signs else 1.0
    sources = min(1.0, len(docs) / 3)
    verified = len(facts) / (len(facts) + rejected) if (facts or rejected) else 0.0
    score = 0.3 * coverage + 0.25 * sources + 0.2 * fresh + 0.15 * agreement + 0.1 * verified
    if not facts:
        score = min(score, 0.2)
    label = "high" if score >= 0.75 else "medium" if score >= 0.5 else "low"
    if label == "high" and contested:
        label = "medium"  # unresolved disagreement caps confidence
    return {
        "score": round(score, 2), "label": label,
        "factors": {"query_coverage": round(coverage, 2), "independent_sources": len(docs),
                    "source_diversity": round(sources, 2), "freshness": round(fresh, 2),
                    "agreement": round(agreement, 2), "verified_ratio": round(verified, 2)},
        "method": "Heuristic and uncalibrated: weighted evidence coverage, source count, "
                  "freshness, tonal agreement and citation verification; capped at medium "
                  "when sources contradict each other. Not a probability.",
    }


# --- offline extractive engine ----------------------------------------------------------
def extractive_draft(question: str, evidence: list[Evidence]) -> Draft:
    q = set(tokens(question))
    scored: list[tuple[float, int, str]] = []
    for idx, e in enumerate(evidence, start=1):
        for s in sentences(e.chunk.text):
            st = set(tokens(s))
            if not st:
                continue
            overlap = len(q & st)
            if overlap == 0:
                continue
            score = overlap / math.sqrt(len(st)) + (0.35 if re.search(r"\d", s) else 0)
            score += 0.5 / idx  # favour higher-ranked evidence
            scored.append((score, idx, s))
    scored.sort(key=lambda x: -x[0])
    facts: list[Claim] = []
    per_doc: dict[str, int] = {}
    seen: list[set[str]] = []
    for _, idx, s in scored:
        doc = str(evidence[idx - 1].document.id)
        st = set(tokens(s))
        if per_doc.get(doc, 0) >= 2 or any(len(st & o) / len(st | o) > 0.6 for o in seen):
            continue
        facts.append(Claim(s, [idx], s))
        per_doc[doc] = per_doc.get(doc, 0) + 1
        seen.append(st)
        if len(facts) == 6:
            break

    cited = sorted({i for f in facts for i in f.source_ids})
    tones = {i: evidence[i - 1].chunk.sentiment for i in cited}
    pos = [i for i, t in tones.items() if t >= 0.15]
    neg = [i for i, t in tones.items() if t <= -0.15]
    contradictions: list[Claim] = []
    if pos and neg:
        def quote_for(i: int) -> str:
            return next((f.quote for f in facts if i in f.source_ids), "")

        if len(pos) == len(neg):
            for i in pos + neg:
                tone = "positive" if i in pos else "negative"
                other = ", ".join(f"[{j}]" for j in (neg if i in pos else pos))
                contradictions.append(Claim(
                    f"Source [{i}] reads {tone}, while {other} reads the other way.", [i],
                    quote_for(i)))
        else:
            minority = neg if len(pos) > len(neg) else pos
            for i in minority:
                tone = "negative" if i in neg else "positive"
                contradictions.append(Claim(
                    f"Source [{i}] reads {tone}, against the balance of the other cited evidence.",
                    [i], quote_for(i)))
    if not facts:
        interp = "No retrieved passage addresses the question directly."
    elif pos or neg:
        lean = "positive" if len(pos) > len(neg) else "negative" if len(neg) > len(pos) else "mixed"
        interp = (f"Automated lexical reading: the cited evidence leans {lean} "
                  f"({len(pos)} source(s) positive, {len(neg)} negative, "
                  f"{len(cited) - len(pos) - len(neg)} neutral). This is a word-level tone "
                  "measure, not an analytical judgement.")
    else:
        interp = ("Automated lexical reading: the cited evidence is broadly neutral in tone. "
                  "This is a word-level tone measure, not an analytical judgement.")
    return Draft(facts, contradictions, interp, "system")


# --- assembly -----------------------------------------------------------------------------
def build_report(question: str, evidence: list[Evidence], draft: Draft | None,
                 now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    warnings = list(draft.warnings if draft else [])
    sources = [source_view(i, e, now) for i, e in enumerate(evidence, start=1)]
    insufficient = (not evidence or evidence[0].score < MIN_EVIDENCE_SCORE
                    or draft is None or not draft.answerable)
    facts: list[dict] = []
    contradictions: list[dict] = []
    rejected: list[dict] = []
    if draft and not insufficient:
        facts, rejected_f = _verify(draft.facts, evidence)
        contradictions, rejected_c = _verify(draft.contradictions, evidence)
        rejected = rejected_f + rejected_c
        if not facts:
            insufficient = True
    if insufficient:
        warnings.append("Insufficient evidence in the research corpus to answer this question.")
    cited = {i for f in facts + contradictions for i in f["citations"]}
    if cited and all(sources[i - 1]["stale"] for i in cited):
        warnings.append("Every cited source is older than its staleness threshold.")
    elif any(sources[i - 1]["stale"] for i in cited):
        warnings.append("Some cited sources are stale; check for newer information.")
    if any(sources[i - 1]["is_sample"] for i in cited):
        warnings.append("Cites the fictional sample corpus; not real market information.")
    if rejected:
        warnings.append(f"{len(rejected)} proposed claim(s) failed citation verification "
                        "and were removed.")
    return {
        "question": question,
        "generated_at": now.isoformat(),
        "engine": draft.engine if draft else "none",
        "insufficient_evidence": insufficient,
        "facts": facts,
        "interpretation": None if insufficient or not draft else {
            "text": draft.interpretation, "basis": draft.interpretation_basis,
            "label": "Interpretation (model-generated)" if draft.interpretation_basis == "model"
            else "Interpretation (automated heuristic)"},
        "contradictions": contradictions,
        "open_questions": draft.open_questions if draft else [],
        "confidence": confidence(evidence, facts, question, now, len(rejected),
                                 contested=bool(contradictions)),
        "sources": sources,
        "validation": {"claims_proposed": len(facts) + len(contradictions) + len(rejected),
                       "claims_verified": len(facts) + len(contradictions),
                       "claims_rejected": len(rejected), "rejected": rejected},
        "warnings": warnings,
        "disclaimer": DISCLAIMER,
    }


