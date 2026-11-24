"""Operator CLI.

    python -m app.cli create-admin --email you@example.com --name "Your Name"
    python -m app.cli audit-verify                       # verify the chain in the database
    python -m app.cli audit-export --out audit.jsonl     # export (JSON Lines) for archiving
    python -m app.cli audit-verify-file audit.jsonl      # verify an export offline, no database
    python -m app.cli ml-sign-artifacts                  # sign model artifacts trained before Phase 11

The admin password is read from AUREX_ADMIN_PASSWORD or prompted for interactively.
"""

import argparse
import asyncio
import getpass
import hashlib
import json
import os
import sys
from pathlib import Path

from pydantic import ValidationError
from sqlalchemy import select

from app.core.errors import Conflict
from app.core.security import sign_artifact
from app.database.session import SessionLocal, engine
from app.models import ModelVersion, RoleName
from app.schemas.auth import RegisterRequest
from app.services.audit_service import AuditContext, AuditService, export_lines, verify_export
from app.services.auth_service import AuthService


async def create_admin(email: str, name: str, password: str) -> int:
    try:
        RegisterRequest(email=email, full_name=name, password=password)
    except ValidationError as e:
        print(f"Invalid input: {e.errors()[0]['msg']}", file=sys.stderr)
        return 2
    async with SessionLocal() as db:
        try:
            user = await AuthService(db).create_user(email, name, password, RoleName.ADMIN)
        except Conflict as e:
            print(e.message, file=sys.stderr)
            return 1
        await AuditService(db).record(AuditContext(actor_user_id=user.id), "admin.bootstrap",
                                      resource_type="user", resource_id=user.id,
                                      details={"via": "cli"})
        await db.commit()
        print(f"Created administrator {user.email} ({user.id})")
    await engine.dispose()
    return 0


async def audit_verify() -> int:
    async with SessionLocal() as db:
        r = await AuditService(db).verify_chain()
    await engine.dispose()
    print(json.dumps(r, default=str))
    return 0 if r["valid"] else 1


async def audit_export(out: str, from_id: int) -> int:
    async with SessionLocal() as db:
        lines = [line async for line in export_lines(db, from_id)]
        n = len(lines)
        await asyncio.to_thread(Path(out).write_text, "".join(lines), encoding="utf-8")
        await AuditService(db).record(AuditContext(), "admin.audit.export", details={"from_id": from_id, "via": "cli"})
        await db.commit()
    await engine.dispose()
    print(f"Exported {n - 1} records to {out}")
    return 0


def audit_verify_file(path: str) -> int:
    with open(path, encoding="utf-8") as f:
        r = verify_export(f)
    print(json.dumps(r))
    return 0 if r["valid"] else 1


async def ml_sign_artifacts(confirm: bool) -> int:
    """Sign artifacts that predate HMAC signing. Run only on a database you trust: signing
    vouches for the bytes that are there now. Artifacts whose SHA-256 no longer matches are skipped."""
    signed = skipped = 0
    async with SessionLocal() as db:
        rows = await db.scalars(select(ModelVersion).where(ModelVersion.artifact_hmac.is_(None)))
        for v in rows:
            await db.refresh(v, ["artifact"])
            if hashlib.sha256(v.artifact).hexdigest() != v.artifact_sha256:
                skipped += 1
                continue
            if confirm:
                v.artifact_hmac = sign_artifact(v.artifact)
            signed += 1
        if confirm:
            await AuditService(db).record(AuditContext(), "ml.artifacts.sign",
                                          details={"signed": signed, "skipped": skipped})
            await db.commit()
    await engine.dispose()
    print(f"{'Signed' if confirm else 'Would sign'} {signed} artifact(s); skipped {skipped} with a hash mismatch."
          + ("" if confirm else " Re-run with --yes to apply."))
    return 0


def main() -> None:
    p = argparse.ArgumentParser(prog="aurex")
    sub = p.add_subparsers(dest="cmd", required=True)
    ca = sub.add_parser("create-admin")
    ca.add_argument("--email", required=True)
    ca.add_argument("--name", default="Administrator")
    sub.add_parser("audit-verify")
    ae = sub.add_parser("audit-export")
    ae.add_argument("--out", required=True)
    ae.add_argument("--from-id", type=int, default=1)
    av = sub.add_parser("audit-verify-file")
    av.add_argument("path")
    ms = sub.add_parser("ml-sign-artifacts")
    ms.add_argument("--yes", action="store_true")
    args = p.parse_args()
    if args.cmd == "create-admin":
        password = os.environ.get("AUREX_ADMIN_PASSWORD") or getpass.getpass("Password: ")
        sys.exit(asyncio.run(create_admin(args.email, args.name, password)))
    elif args.cmd == "audit-verify":
        sys.exit(asyncio.run(audit_verify()))
    elif args.cmd == "audit-export":
        sys.exit(asyncio.run(audit_export(args.out, args.from_id)))
    elif args.cmd == "audit-verify-file":
        sys.exit(audit_verify_file(args.path))
    elif args.cmd == "ml-sign-artifacts":
        sys.exit(asyncio.run(ml_sign_artifacts(args.yes)))


if __name__ == "__main__":
    main()
