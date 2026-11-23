"""Embedding providers.

The default `HashingEmbedder` runs locally with no model download or API key: signed
feature hashing of stemmed unigrams and bigrams into 384 dimensions, L2-normalised.
It captures lexical similarity (not deep semantics) and is the honest baseline; every
chunk records which embedder produced it so a stronger model can be swapped in and
re-indexed later without mixing vector spaces.
"""

import math
from typing import Protocol

from app.market.providers.synthetic import fnv1a
from app.research.text import tokens

DIM = 384


class Embedder(Protocol):
    name: str
    dim: int

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class HashingEmbedder:
    name = "hashing-v1-384"
    dim = DIM

    def _one(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        toks = tokens(text)
        feats: dict[str, float] = {}
        for t in toks:
            feats[t] = feats.get(t, 0) + 1.0
        for a, b in zip(toks, toks[1:], strict=False):
            key = f"{a}_{b}"
            feats[key] = feats.get(key, 0) + 0.5
        for f, tf in feats.items():
            h = fnv1a(f)
            sign = 1.0 if (h >> 31) & 1 else -1.0
            vec[h % self.dim] += sign * (1 + math.log(tf))
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [round(v / norm, 6) for v in vec]

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]


_embedder: Embedder = HashingEmbedder()


def get_embedder() -> Embedder:
    return _embedder


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))
