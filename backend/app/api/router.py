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
    research,
    risk,
    system,
    trading,
    users,
)

api_router = APIRouter()
for module in (system, auth, users, accounts, markets, research, ai, ml, backtests, trading, risk, analytics, admin):
    api_router.include_router(module.router)
