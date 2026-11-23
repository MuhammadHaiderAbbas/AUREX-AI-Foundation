"""Text utilities shared by extraction, chunking, embeddings and reporting.

Mirrored in frontend/src/services/demo/research.ts for the static demo.
"""

import re
import unicodedata
from html.parser import HTMLParser

STOPWORDS = frozenset(""" 
a about above after again against all am an and any are as at be because been before being below
between both but by can could did do does doing down during each few for from further had has have
having he her here hers herself him himself his how i if in into is it its itself just me more most my
myself no nor not now of off on once only or other our ours ourselves out over own same she should so
some such than that the their theirs them themselves then there these they this those through to too
under until up very was we were what when where which while who whom why will with would you your
yours yourself yourselves also its per via what's s t
""".split())

_TOKEN = re.compile(r"[a-z0-9]+(?:[./][a-z0-9]+)*")
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")
_SUFFIXES = ("ations", "ation", "ings", "ing", "edly", "ed", "ies", "es", "ly", "s")


def normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    text = text.replace("–", "-").replace("—", "-").replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def squash(text: str) -> str:
    """Whitespace/case/quote-insensitive form used to verify that quotes appear in sources."""
    return re.sub(r"\s+", " ", normalise(text)).strip().lower()


def stem(token: str) -> str:
    if token.isdigit() or len(token) <= 4:
        return token
    for suf in _SUFFIXES:
        if token.endswith(suf) and len(token) - len(suf) >= 3:
            return token[: -len(suf)]
    return token


def tokens(text: str, *, keep_stopwords: bool = False) -> list[str]:
    raw = _TOKEN.findall(text.lower())
    return [stem(t) for t in raw if keep_stopwords or t not in STOPWORDS]


def sentences(text: str) -> list[str]:
    out = []
    for para in re.split(r"\n\s*\n", text):
        para = re.sub(r"\s+", " ", para).strip()
        if para:
            out.extend(s.strip() for s in _SENT_SPLIT.split(para) if s.strip())
    return out


class _HTMLText(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg", "head", "nav", "footer", "form"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section",
             "article", "blockquote", "pre", "table", "ul", "ol"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if not self.skip:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str, str]:
    """Returns (title, visible text). Script/style/navigation content is dropped."""
    p = _HTMLText()
    p.feed(html)
    p.close()
    text = "".join(p.parts)
    text = "\n\n".join(re.sub(r"\s+", " ", b).strip() for b in re.split(r"\n\s*\n", text))
    return normalise(p.title), normalise(re.sub(r"\n{3,}", "\n\n", text))
