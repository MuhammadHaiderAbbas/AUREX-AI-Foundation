from fastapi import APIRouter

from app.api.v1 import accounts, admin, auth, markets, research, system, users

api_router = APIRouter()
for module in (system, auth, users, accounts, markets, research, admin):
    api_router.include_router(module.router)
