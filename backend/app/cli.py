"""Operator CLI.

    python -m app.cli create-admin --email you@example.com --name "Your Name"

The password is read from AUREX_ADMIN_PASSWORD or prompted for interactively.
"""

import argparse
import asyncio
import getpass
import os
import sys

from pydantic import ValidationError

from app.core.errors import Conflict
from app.database.session import SessionLocal, engine
from app.models import RoleName
from app.schemas.auth import RegisterRequest
from app.services.audit_service import AuditContext, AuditService
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


def main() -> None:
    p = argparse.ArgumentParser(prog="aurex")
    sub = p.add_subparsers(dest="cmd", required=True)
    ca = sub.add_parser("create-admin")
    ca.add_argument("--email", required=True)
    ca.add_argument("--name", default="Administrator")
    args = p.parse_args()
    if args.cmd == "create-admin":
        password = os.environ.get("AUREX_ADMIN_PASSWORD") or getpass.getpass("Password: ")
        sys.exit(asyncio.run(create_admin(args.email, args.name, password)))


if __name__ == "__main__":
    main()
