"""Password policy (NIST SP 800-63B style): length and variety, plus a block-list check.

The block list catches the passwords that pass a composition rule but are still guessed
first: a common word or keyboard run dressed up with capitals, digits and a symbol
("Password123!", "Qwerty12345!", "Welcome2026!"), or the user's own name or email.
"""

import re

MIN_LENGTH = 12

# Lower-case bases that crackers try first. Checked after stripping leading/trailing digits
# and symbols and undoing common character substitutions.
COMMON_BASES = frozenset("""
password passw0rd passphrase welcome letmein iloveyou admin administrator qwerty qwertyuiop
asdfgh asdfghjkl zxcvbn monkey dragon football baseball basketball soccer hockey sunshine
princess shadow master superman batman trustno starwars whatever freedom secret changeme
default login abc abcdef abcdefg abcdefgh access summer winter spring autumn january
february march april may june july august september october november december monday
friday sunday hello charlie michael jennifer jordan computer internet mustang ferrari
liverpool chelsea arsenal london paris trading trader bitcoin crypto ethereum money
invest investor aurex market stocks forex profit wallet blockchain
""".split())

KEYBOARD_RUNS = ("qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "0987654321", "abcdefghijklmnopqrstuvwxyz")
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i"})


def _core(password: str) -> str:
    """Lower-case, strip decoration at both ends, undo l33t substitutions."""
    p = password.lower()
    p = re.sub(r"^[^a-z]+|[^a-z]+$", "", p) or p
    return p.translate(_LEET)


def problems(password: str, *, email: str | None = None, name: str | None = None) -> list[str]:
    out = []
    if len(password) < MIN_LENGTH:
        out.append(f"Password must be at least {MIN_LENGTH} characters")
    classes = sum(bool(re.search(p, password)) for p in (r"[a-z]", r"[A-Z]", r"\d", r"[^A-Za-z0-9]"))
    if classes < 3:
        out.append("Password must contain at least three of: lowercase, uppercase, digit, symbol")
    core = _core(password)
    lower = password.lower()
    in_run = any(core in run and len(core) >= 4 for run in KEYBOARD_RUNS)
    if core in COMMON_BASES or re.fullmatch(r"(.)\1+", core) or in_run:
        out.append("Password is too common: avoid dictionary words, keyboard patterns and repeated characters")
    elif any(run[i:i + 6] in lower for run in KEYBOARD_RUNS for i in range(len(run) - 5)):
        out.append("Password contains a keyboard or number sequence")
    personal = []
    if email:
        local = email.split("@")[0].lower()
        personal += [t for t in re.split(r"[^a-z0-9]+", local) if len(t) >= 4]
    if name:
        personal += [t for t in re.split(r"[^a-z0-9]+", name.lower()) if len(t) >= 4]
    if any(t in lower or t in core for t in personal):
        out.append("Password must not contain your name or email address")
    return out


def validate(password: str, *, email: str | None = None, name: str | None = None) -> str:
    errs = problems(password, email=email, name=name)
    if errs:
        raise ValueError(errs[0])
    return password
