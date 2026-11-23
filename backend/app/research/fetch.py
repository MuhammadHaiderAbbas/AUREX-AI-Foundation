"""Safe retrieval of web documents and RSS/Atom feeds for ingestion.

Guards: explicit host allow-list (AUREX_RESEARCH_ALLOWED_HOSTS), https only, no redirects
to other hosts, size cap, timeout, and defusedxml for feed parsing (XXE / billion-laughs).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

import httpx
from defusedxml import ElementTree

from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, Forbidden
from app.research.extract import MAX_BYTES
from app.research.text import html_to_text

_client: httpx.AsyncClient | None = None


def set_http_client(client: httpx.AsyncClient | None) -> None:
    global _client
    _client = client


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=15.0, follow_redirects=False,
                                    headers={"User-Agent": "aurex-research/0.3"})
    return _client


def check_url(url: str) -> str:
    u = urlparse(url)
    allowed = {h.lower() for h in get_settings().research_allowed_hosts}
    if u.scheme != "https" or not u.hostname:
        raise BusinessRuleViolation("Only https:// URLs can be ingested")
    if not allowed:
        raise Forbidden("URL ingestion is disabled (set AUREX_RESEARCH_ALLOWED_HOSTS)")
    if u.hostname.lower() not in allowed:
        raise Forbidden(f"Host {u.hostname} is not on the research allow-list")
    return url


async def fetch(url: str) -> tuple[bytes, str | None]:
    check_url(url)
    try:
        async with _http().stream("GET", url) as r:
            if r.is_redirect:
                target = r.headers.get("location", "")
                raise BusinessRuleViolation(f"Redirects are not followed (to {target[:200]})")
            if r.status_code != 200:
                raise BusinessRuleViolation(f"Source returned HTTP {r.status_code}")
            buf = bytearray()
            async for part in r.aiter_bytes():
                buf.extend(part)
                if len(buf) > MAX_BYTES:
                    raise BusinessRuleViolation("Document exceeds the 10 MB limit")
            return bytes(buf), r.headers.get("content-type")
    except httpx.HTTPError as e:
        raise BusinessRuleViolation(f"Could not fetch source: {e.__class__.__name__}") from e


@dataclass
class FeedItem:
    title: str
    text: str
    link: str | None
    published_at: datetime | None


def _date(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.strip()
    try:
        return parsedate_to_datetime(s).astimezone(UTC)
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None


def parse_feed(data: bytes) -> list[FeedItem]:
    try:
        root = ElementTree.fromstring(data)
    except Exception as e:  # noqa: BLE001 - defusedxml raises several types
        raise BusinessRuleViolation(f"Invalid feed XML: {e.__class__.__name__}") from e

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    items = []
    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        fields: dict[str, str] = {}
        link = None
        for child in el:
            name = local(child.tag)
            if name == "link":
                link = child.get("href") or (child.text or "").strip() or link
            elif child.text:
                fields.setdefault(name, child.text)
        title = html_to_text(fields.get("title", ""))[1] or "(untitled)"
        body = fields.get("encoded") or fields.get("content") or fields.get("description") \
            or fields.get("summary") or ""
        text = html_to_text(body)[1]
        published = _date(fields.get("pubDate") or fields.get("published") or fields.get("updated"))
        if text:
            items.append(FeedItem(title[:300], text, link, published))
    return items[:100]
