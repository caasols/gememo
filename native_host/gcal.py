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


def _event_meet_code(event):
    """Best-effort Meet room code ('abc-defg-hij') from a calendar event."""
    event = event or {}
    m = _MEET_CODE_RE.search(event.get('hangoutLink') or '')
    if m:
        return m.group(1)
    conf = event.get('conferenceData') or {}
    m = _MEET_CODE_RE.search(conf.get('conferenceId') or '')
    if m:
        return m.group(1)
    for ep in conf.get('entryPoints') or []:
        m = _MEET_CODE_RE.search(ep.get('uri') or '')
        if m:
            return m.group(1)
    return ''


def _nearest_by_time(events, timestamp_iso):
    if not events:
        return None
    target = _parse_iso(timestamp_iso)
    if target is None:
        return events[0]

    def dist(e):
        st = _event_start(e)
        return abs((st - target).total_seconds()) if st else float('inf')

    return min(events, key=dist)


def match_calendar_event(events, meeting_code, timestamp_iso='', title=''):
    """Find the calendar event for the captured meeting.
    1) exact Meet-code match (nearest time if duplicates);
    2) fallback: events whose title contains `title`, nearest by time;
    3) else nearest by time over all events. Returns the event dict or None.
    """
    events = events or []
    if not events:
        return None
    code = (meeting_code or '').strip().lower()
    if code:
        coded = [e for e in events if _event_meet_code(e).lower() == code]
        if len(coded) == 1:
            return coded[0]
        if len(coded) > 1:
            return _nearest_by_time(coded, timestamp_iso)
    candidates = events
    t = (title or '').strip().lower()
    if t:
        titled = [e for e in events if t in (e.get('summary') or '').lower()]
        if titled:
            candidates = titled
    return _nearest_by_time(candidates, timestamp_iso)


def _scheduled_duration_min(event):
    start = (event or {}).get('start') or {}
    end = (event or {}).get('end') or {}
    if start.get('dateTime') and end.get('dateTime'):
        s, e = _parse_iso(start['dateTime']), _parse_iso(end['dateTime'])
        if s and e and e > s:
            return int((e - s).total_seconds() // 60)
    return None


def extract_calendar_fields(event, redact_emails=False):
    """Map a calendar event → a frontmatter-fields dict. Attendee emails are
    omitted when redact_emails is True (privacy)."""
    if not event:
        return {}
    out = {}
    if event.get('recurringEventId'):
        out['recurring_event_id'] = event['recurringEventId']
    desc = (event.get('description') or '').strip()
    if desc:
        out['description'] = desc
    org = event.get('organizer') or {}
    organizer = org.get('email') or org.get('displayName') or ''
    if organizer:
        out['organizer'] = organizer
    if not redact_emails:
        emails = [a.get('email') for a in (event.get('attendees') or []) if a.get('email')]
        if emails:
            out['attendee_emails'] = emails
    start = event.get('start') or {}
    end = event.get('end') or {}
    sval = start.get('dateTime') or start.get('date')
    eval_ = end.get('dateTime') or end.get('date')
    if sval:
        out['scheduled_start'] = sval
    if eval_:
        out['scheduled_end'] = eval_
    dur = _scheduled_duration_min(event)
    if dur is not None:
        out['scheduled_duration_min'] = dur
    return out
