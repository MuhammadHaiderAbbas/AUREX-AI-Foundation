from fastapi import APIRouter

from app.api.v1 import accounts, admin, ai, auth, backtests, markets, ml, research, system, trading, users

api_router = APIRouter()
for module in (system, auth, users, accounts, markets, research, ai, ml, backtests, trading, admin):
    api_router.include_router(module.router)
