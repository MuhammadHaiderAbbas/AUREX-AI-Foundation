"""Financial research engine (Phase 4).

Pipeline:  ingest → extract → classify/tag → chunk → embed → index (pgvector + full text)
           ask → hybrid retrieve → grounded report (verified facts, labelled interpretation,
           contradictions, confidence, staleness) → persisted, cited, never auto-executed.
"""
