import uuid
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import coach
from app.api.deps import current_trader
from app.core.config import get_settings
from app.core.errors import RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.models import User

router = APIRouter(prefix="/coach", tags=["coach"])
limiter = SlidingWindowLimiter("coach_ask")


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class CoachAsk(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    account_id: uuid.UUID | None = None
    history: list[Turn] = Field(default_factory=list, max_length=6)


class CoachAnswer(BaseModel):
    answer: str
    facts: list[str]
    engine: str
    suggestions: list[str]


@router.post("/ask", response_model=CoachAnswer)
async def ask(data: CoachAsk, user: User = Depends(current_trader), db: AsyncSession = Depends(get_db)):
    """Plain-English answers about your own account (bot results, AI decisions, performance, terms)."""
    if not await limiter.hit(str(user.id), get_settings().coach_asks_per_hour, 3600):
        raise RateLimited("Too many coach questions this hour; try again later")
    a = await coach.ask(db, user, data.question, data.account_id, [t.model_dump() for t in data.history])
    return CoachAnswer(answer=a.answer, facts=a.facts, engine=a.engine, suggestions=a.suggestions)
