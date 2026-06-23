# gdocs.py — all Google Docs logic for Gememo (5.7), isolated so the rest of the
# native host stays stdlib-only. SAFETY: this is a SEPARATE, self-contained OAuth
# grant — it has its OWN scope + token file (token_docs.json) and NEVER touches
# gcal.py / token.json. The already-shipped Calendar beta is unaffected.
#
# The OAuth/API functions need the google-* libraries; markdown_to_docs_requests
# and the injectable create_doc path are pure / unit-testable without them.
import re
from pathlib import Path

try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    GDOCS_AVAILABLE = True
except ImportError:
    GDOCS_AVAILABLE = False

# Docs-only scope. Distinct from Calendar's calendar.readonly scope.
SCOPES = ['https://www.googleapis.com/auth/documents']
CONFIG_DIR = Path.home() / '.config' / 'gememo'
CREDENTIALS_PATH = CONFIG_DIR / 'credentials.json'   # reused OAuth client (same as gcal)
TOKEN_PATH = CONFIG_DIR / 'token_docs.json'          # DISTINCT from Calendar's token.json

_BOLD_RE = re.compile(r'\*\*(.+?)\*\*')


def _render_inline(text):
    """Strip **bold** markers from `text`, returning (plain_text, [(start, end), ...])
    where each (start, end) is a bold range expressed as offsets within plain_text.
    Unknown inline markup is left as-is (degrades to plain text, never raises)."""
    plain = []
    bolds = []
    pos = 0  # offset within the assembled plain string
    idx = 0  # scan position within the original text
    for m in _BOLD_RE.finditer(text):
        # text before the bold run
        before = text[idx:m.start()]
        plain.append(before)
        pos += len(before)
        inner = m.group(1)
        plain.append(inner)
        bolds.append((pos, pos + len(inner)))
        pos += len(inner)
        idx = m.end()
    plain.append(text[idx:])
    return ''.join(plain), bolds


def markdown_to_docs_requests(markdown):
    """Convert note markdown into a list of Docs API batchUpdate request dicts.

    Supported, in a single forward pass that tracks the running insertion index:
      - `#`/`##`/`###`  → paragraph with HEADING_1/2/3 named style
      - `- ` / `* `     → createParagraphBullets on the inserted line
      - `**bold**`      → updateTextStyle bold ranges
      - plain lines     → inserted verbatim
      - empty/whitespace input → []
    Unknown markup degrades to plain text. Never raises."""
    if not markdown or not markdown.strip():
        return []

    requests = []
    index = 1  # Docs body starts at index 1

    for raw in markdown.split('\n'):
        line = raw.rstrip('\n')
        stripped = line.strip()

        heading = None
        is_bullet = False
        content = line

        hm = re.match(r'^(#{1,3})\s+(.*)$', stripped)
        if hm:
            heading = len(hm.group(1))
            content = hm.group(2)
        elif re.match(r'^[-*]\s+', stripped):
            is_bullet = True
            content = re.sub(r'^[-*]\s+', '', stripped)

        plain, bolds = _render_inline(content)
        text = plain + '\n'
        start = index

        requests.append({
            'insertText': {'location': {'index': index}, 'text': text}
        })
        end = index + len(text)

        if heading:
            requests.append({
                'updateParagraphStyle': {
                    'range': {'startIndex': start, 'endIndex': end},
                    'paragraphStyle': {'namedStyleType': f'HEADING_{heading}'},
                    'fields': 'namedStyleType',
                }
            })
        if is_bullet:
            requests.append({
                'createParagraphBullets': {
                    'range': {'startIndex': start, 'endIndex': end},
                    'bulletPreset': 'BULLET_DISC_CIRCLE_SQUARE',
                }
            })
        for b_start, b_end in bolds:
            requests.append({
                'updateTextStyle': {
                    'range': {'startIndex': start + b_start, 'endIndex': start + b_end},
                    'textStyle': {'bold': True},
                    'fields': 'bold',
                }
            })

        index = end

    return requests


# ── OAuth / token / API (live; require the google libs; not unit-tested) ──────

def _save_token(creds):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(creds.to_json())


def _load_creds():
    """Load + refresh stored Docs creds, or None. Requires the google libs."""
    if not GDOCS_AVAILABLE or not TOKEN_PATH.exists():
        return None
    try:
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    except Exception:
        return None
    if creds and not creds.valid and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save_token(creds)
        except Exception:
            return None
    return creds


def connect():
    """Run the interactive loopback OAuth flow for the Docs scope (opens the
    browser). Blocking; invoked detached by the host so it can outlive the
    native-messaging window. Independent of Calendar's grant."""
    if not GDOCS_AVAILABLE:
        return {'ok': False, 'error': 'Google libraries not installed — re-run install.sh'}
    if not CREDENTIALS_PATH.exists():
        return {'ok': False, 'error': f'No credentials.json at {CREDENTIALS_PATH} — see GDOCS_SETUP.md'}
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    creds = flow.run_local_server(port=0)
    _save_token(creds)
    return {'ok': True}


def status():
    if not GDOCS_AVAILABLE:
        return {'connected': False, 'available': False}
    creds = _load_creds()
    if not creds:
        return {'connected': False, 'available': True}
    if not creds.valid:
        return {'connected': False, 'available': True, 'needs_reconnect': True}
    return {'connected': True, 'available': True, 'email': ''}


def disconnect():
    try:
        TOKEN_PATH.unlink(missing_ok=True)
    except OSError:
        pass
    return {'ok': True}


def create_doc(title, markdown_body, *, creds=None, service=None):
    """Create one Google Doc titled `title`, then batchUpdate it with the converted
    markdown body. Returns {ok, docId, url, error}. `service`/`creds` are injectable
    so tests can pass a fake Docs service (no network). Best-effort; never raises."""
    try:
        if service is None:
            if creds is None:
                creds = _load_creds()
            if not creds or not GDOCS_AVAILABLE:
                return {'ok': False, 'error': 'not_connected'}
            service = build('docs', 'v1', credentials=creds, cache_discovery=False)

        created = service.documents().create(body={'title': title}).execute()
        doc_id = (created or {}).get('documentId')
        if not doc_id:
            return {'ok': False, 'error': 'no documentId returned'}

        requests = markdown_to_docs_requests(markdown_body)
        service.documents().batchUpdate(
            documentId=doc_id, body={'requests': requests}
        ).execute()

        url = f'https://docs.google.com/document/d/{doc_id}/edit'
        return {'ok': True, 'docId': doc_id, 'url': url}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


if __name__ == '__main__':
    import sys
    sys.exit(0 if connect().get('ok') else 1)
