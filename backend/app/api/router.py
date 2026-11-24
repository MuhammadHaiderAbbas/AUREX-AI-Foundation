from fastapi import APIRouter

from app.api.v1 import (
    accounts,
    admin,
    ai,
    analytics,
    auth,
    backtests,
    markets,
    ml,
    ops,
    research,
    risk,
    system,
    trading,
    users,
)

api_router = APIRouter()
MODULES = (system, auth, users, accounts, markets, research, ai, ml, backtests, trading, risk, analytics, admin, ops)
for module in MODULES:
    api_router.include_router(module.router)
