"""Rule-based document classification, instrument tagging and lexical sentiment.

Deliberately transparent heuristics: every label can be explained. An ML classifier can
replace them later (Phase 6) behind the same functions.
"""

import re

from app.research.text import tokens

DOC_TYPES = ("earnings", "filing", "central_bank", "economic_data", "news", "analysis", "other")

_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("central_bank", ("monetary policy", "policy rate", "rate decision", "central bank",
                      "basis points", "policy committee", "interest rate decision")),
    ("earnings", ("quarterly results", "third-quarter", "second-quarter", "first-quarter",
                  "fourth-quarter", "earnings per share", "revenue", "guidance",
                  "fiscal year results")),
    ("filing", ("form 10-k", "form 10-q", "form 8-k", "annual report", "companies house",
                "securities and exchange commission", "pursuant to")),
    ("economic_data", ("unemployment rate", "inflation rate", "consumer price index", "cpi",
                       "payrolls", "gdp", "labour market", "labor market", "pmi")),
    ("analysis", ("analyst", "price target", "we expect", "our view", "outlook", "research note")),
]

# Maximum useful age per document type before evidence is flagged stale (days).
STALE_AFTER_DAYS = {"news": 7, "analysis": 30, "economic_data": 45, "central_bank": 60,
                    "earnings": 120, "filing": 400, "other": 365}

POSITIVE = frozenset(tokens(
    "beat beats beating growth grew grow increase increased rise rose rising strong stronger "
    "strength improve improved improvement record raised raise upgrade upgraded outperform gain "
    "gains expansion expanded robust surge surged accelerate accelerated positive supported "
    "support resilient exceed exceeded exceeding rebound recovered recovery optimistic higher "
    "profitable profit tailwind inflows", keep_stopwords=True))
NEGATIVE = frozenset(tokens(
    "miss missed misses decline declined declining fall fell falling weak weaker weakness loss "
    "losses downgrade downgraded risk risks concern concerns slowdown slowing slowed contraction "
    "deteriorate deteriorated deterioration pressure pressures volatility uncertainty default "
    "lawsuit warn warned warning lower lowered headwind headwinds outflows disappointing "
    "shortfall cautious elevated build-up buildup", keep_stopwords=True))
_NEGATORS = {"not", "no", "never", "without", "neither"}


def classify(title: str, text: str) -> str:
    hay = f"{title}\n{text[:6000]}".lower()
    best, best_hits = "news", 0
    for doc_type, cues in _RULES:
        hits = sum(hay.count(c) for c in cues)
        if hits > best_hits:
            best, best_hits = doc_type, hits
    return best if best_hits else "news"


def sentiment(text: str) -> float:
    """Lexical tone in [-1, 1]. A negator flips the next sentiment word within three tokens,
    and never crosses punctuation."""
    pos = neg = 0
    flip = 0
    for tok in re.findall(r"[a-z0-9-]+|[.,;:!?]", text.lower()):
        if tok in ".,;:!?":
            flip = 0
            continue
        if tok in _NEGATORS:
            flip = 3
            continue
        t = tokens(tok, keep_stopwords=True)
        t = t[0] if t else tok
        hit_pos, hit_neg = t in POSITIVE, t in NEGATIVE
        if flip:
            if hit_pos or hit_neg:
                hit_pos, hit_neg = hit_neg, hit_pos
                flip = 0
            else:
                flip -= 1
        pos += hit_pos
        neg += hit_neg
    return round((pos - neg) / (pos + neg + 1), 4)


def tag_instruments(text: str, aliases: dict[str, list[str]]) -> list[str]:
    """aliases: symbol -> list of names/tickers. Whole-word, case-sensitive for short tickers."""
    found = []
    for symbol, names in aliases.items():
        for name in names:
            flags = 0 if len(name) <= 4 else re.IGNORECASE
            if re.search(rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", text, flags):
                found.append(symbol)
                break
    return sorted(found)
