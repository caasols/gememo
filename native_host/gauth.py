# gauth.py — one-flow Google connect for Gememo. A single consent grants the Docs
# scope and writes the creds to the token file that gdocs.py (token_docs.json)
# reads — so one click lights up the Google Docs output. (Calendar parked.)
#
# Paths are defined directly here (not imported from gdocs) to avoid coupling,
# but they MUST stay in lockstep with that module's path. The OAuth/API functions
# need the google-* libraries; the file ops + status logic are unit-testable
# without them (mirrors gdocs.py's split).
from pathlib import Path

try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    GAUTH_AVAILABLE = True
except ImportError:
    GAUTH_AVAILABLE = False

# Docs-only scope (Calendar parked). Order/relaxation handled in connect().
SCOPES = ['https://www.googleapis.com/auth/documents']
CONFIG_DIR = Path.home() / '.config' / 'gememo'
CREDENTIALS_PATH = CONFIG_DIR / 'credentials.json'
# MUST match gdocs.TOKEN_PATH so that module picks up the token written here.
# Defined directly to avoid importing it.
DOCS_TOKEN_PATH = CONFIG_DIR / 'token_docs.json'   # Docs (== gdocs.TOKEN_PATH)
ACCOUNT_PATH = CONFIG_DIR / 'account.json'


# ── OAuth / token / API (live; require the google libs; guarded from unit tests) ──

def _save_token(path, creds):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(creds.to_json())


def _load_creds_for(path):
    """Load + refresh stored creds at `path`, or None. Requires the google libs.
    Mirrors gdocs._load_creds, parameterised over the token path."""
    path = Path(path)
    if not GAUTH_AVAILABLE or not path.exists():
        return None
    try:
        creds = Credentials.from_authorized_user_file(str(path), SCOPES)
    except Exception:
        return None
    if creds and not creds.valid and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save_token(path, creds)
        except Exception:
            return None
    return creds


def _fetch_primary_email(creds):
    try:
        svc = build('calendar', 'v3', credentials=creds, cache_discovery=False)
        return svc.calendarList().get(calendarId='primary').execute().get('id', '')
    except Exception:
        return ''


def connect():
    """Run ONE interactive loopback OAuth flow requesting the Docs scope (opens the
    browser). Writes the resulting creds to the Docs token file so gdocs picks them
    up. Blocking; invoked detached by the host so it outlives Chrome's native-
    messaging window."""
    if not GAUTH_AVAILABLE:
        return {'ok': False, 'error': 'Google libraries not installed — re-run install.sh'}
    if not CREDENTIALS_PATH.exists():
        return {'ok': False, 'error': f'No credentials.json at {CREDENTIALS_PATH} — see GDOCS_SETUP.md'}
    import os
    # Google may grant the scopes back in a different order / with extra scopes;
    # relaxing the scope check keeps the single combined grant from erroring.
    os.environ['OAUTHLIB_RELAX_TOKEN_SCOPE'] = '1'
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    creds = flow.run_local_server(port=0, prompt='consent')
    # Docs only — gdocs reads token_docs.json.
    _save_token(DOCS_TOKEN_PATH, creds)
    email = _fetch_primary_email(creds)
    if email:
        import json
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        ACCOUNT_PATH.write_text(json.dumps({'email': email}))
    return {'ok': True, 'email': email}


def status():
    """Connected only when the Docs token file loads valid (or refreshable) creds —
    i.e. the grant is live for Docs."""
    if not GAUTH_AVAILABLE:
        return {'connected': False, 'available': False}
    docs = _load_creds_for(DOCS_TOKEN_PATH)
    if not docs:
        return {'connected': False, 'available': True}
    if not docs.valid:
        return {'connected': False, 'available': True, 'needs_reconnect': True}
    email = ''
    if ACCOUNT_PATH.exists():
        try:
            import json
            email = json.loads(ACCOUNT_PATH.read_text()).get('email', '')
        except Exception:
            email = ''
    return {'connected': True, 'available': True, 'email': email}


def disconnect():
    """Drop the Docs token file + the cached account email. Leaves the grant
    fully revoked locally (the user re-connects with one click)."""
    for p in (DOCS_TOKEN_PATH, ACCOUNT_PATH):
        try:
            Path(p).unlink(missing_ok=True)
        except OSError:
            pass
    return {'ok': True}


if __name__ == '__main__':
    import sys
    sys.exit(0 if connect().get('ok') else 1)
