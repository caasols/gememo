# gcal.py — all Google Calendar logic for Gememo (5.3), isolated so the rest of
# the native host stays stdlib-only. The OAuth/API functions need the google-*
# libraries; everything else (matching, extraction, orchestration) is pure and
# unit-testable without them.
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    GCAL_AVAILABLE = True
except ImportError:
    GCAL_AVAILABLE = False

SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
CONFIG_DIR = Path.home() / '.config' / 'gememo'
CREDENTIALS_PATH = CONFIG_DIR / 'credentials.json'
TOKEN_PATH = CONFIG_DIR / 'token.json'
ACCOUNT_PATH = CONFIG_DIR / 'account.json'

_MEET_CODE_RE = re.compile(r'([a-z]{3}-[a-z]{4}-[a-z]{3})', re.I)


def _parse_iso(s):
    """Parse an ISO-8601 string (tolerating a trailing 'Z') → aware datetime, or None."""
    s = (s or '').strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        return None


def _event_start(event):
    """Return an aware datetime for a calendar event's start (timed or all-day), or None."""
    start = (event or {}).get('start') or {}
    if start.get('dateTime'):
        return _parse_iso(start['dateTime'])
    if start.get('date'):
        return _parse_iso(start['date'] + 'T00:00:00+00:00')
    return None
