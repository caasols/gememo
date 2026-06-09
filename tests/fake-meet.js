// fake-meet.js — a minimal fake Google Meet page + HTTP server used to drive the
// REAL extension/content_meet.js content script in an e2e test.
//
// The page reproduces the SELECTORS contract from extension/constants.js in the
// "Gemini started, side panel open" state so the content script's join detection
// and Gemini capture flow both run against it:
//   • button[aria-label="Leave call"]               (leaveButton — triggers join)
//   • button[aria-label="Turn off microphone"]      (micOff)
//   • button[aria-label="Turn off camera"]          (camOff)
//   • button[aria-label="Gemini"]                   (Gemini toggle the script keys on)
//   • div[aria-label="Call controls"]               (callControls)
//   • aside[aria-label="Side panel"]                (sidePanel)
//   • div[aria-label="Ask Gemini"][contenteditable] (geminiInput, in viewport)
//   • button[aria-label="Submit"]                   (submit)
//
// Submitting (Enter on the input, or a click on Submit) appends a response block
// to the side panel whose text is:
//     Gemini response\n<SENTINEL_TRANSCRIPT>
// so extractLastResponse() (split on "Gemini response\n", last part) returns the
// sentinel — letting the capture test assert the forwarded payload end-to-end.

const http = require('http');

// Known sentinel the capture test asserts on. Multi-line so it also proves the
// split/strip logic in extractLastResponseFromEl survives newlines.
const SENTINEL_TRANSCRIPT = 'FAKE TRANSCRIPT LINE ONE\nFAKE TRANSCRIPT LINE TWO';

const FAKE_MEET_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Meet - Test Meeting</title>
  <style>
    html, body { margin: 0; height: 100%; }
    /* The Gemini input must have nonzero size and sit inside the viewport so
       content_meet's isInViewport() / IntersectionObserver checks pass. */
    aside[aria-label="Side panel"] {
      position: fixed; top: 0; right: 0; width: 360px; height: 100%;
      box-sizing: border-box; padding: 12px; background: #fff;
    }
    div[aria-label="Ask Gemini"] {
      display: block; width: 320px; min-height: 40px; border: 1px solid #888;
    }
    div[aria-label="Call controls"] {
      position: fixed; bottom: 0; left: 0; width: 100%; height: 64px;
    }
    .gemini-response { white-space: pre-wrap; }
  </style>
</head>
<body>
  <!-- Call controls toolbar (callControls + mic/cam/leave/Gemini buttons) -->
  <div aria-label="Call controls">
    <button aria-label="Turn off microphone">Mic</button>
    <button aria-label="Turn off camera">Cam</button>
    <!-- The active-state Gemini toggle the content script keys on
         (button[aria-label*="Gemini"]). Its presence means isGeminiAvailable()
         returns true and runGeminiFlow's "Gemini not active" guard passes. -->
    <button aria-label="Gemini">Gemini</button>
    <button aria-label="Leave call">Leave call</button>
  </div>

  <!-- Gemini side panel, already open: input is in the viewport + Submit button -->
  <aside aria-label="Side panel">
    <div aria-label="Ask Gemini" contenteditable="true" role="textbox"></div>
    <button aria-label="Submit">Submit</button>
    <div id="gemini-responses"></div>
  </aside>

  <script>
    (function () {
      var input = document.querySelector('div[aria-label="Ask Gemini"][contenteditable="true"]');
      var submit = document.querySelector('button[aria-label="Submit"]');
      var responses = document.getElementById('gemini-responses');
      var SENTINEL = ${JSON.stringify(SENTINEL_TRANSCRIPT)};
      var answered = false;

      // Render the reply in Meet's 2026-06 DOM shape: a role="listitem" row holding
      // a "Gemini response" label, the answer text, then an action row with the Copy
      // button (jsname="WmNl5c"). This exercises lastGeminiResponseEl (last list-item)
      // + geminiResponseDone (that item has a Copy button). Idempotent guard mirrors
      // Meet streaming a single reply per submit.
      function answer() {
        if (answered) return;
        answered = true;
        var item = document.createElement('div');
        item.setAttribute('role', 'listitem');
        item.className = 'gemini-response';
        var label = document.createElement('div');
        label.textContent = 'Gemini response';
        var text = document.createElement('div');
        text.textContent = SENTINEL;
        var actions = document.createElement('div');
        var copyBtn = document.createElement('button');
        copyBtn.setAttribute('jsname', 'WmNl5c');
        copyBtn.setAttribute('data-action-type', '15');
        copyBtn.innerHTML = '<span jsname="V67aGc">Copy</span>';
        var reportBtn = document.createElement('button');
        reportBtn.textContent = 'Report';
        actions.appendChild(copyBtn);
        actions.appendChild(reportBtn);
        item.appendChild(label);
        item.appendChild(text);
        item.appendChild(actions);
        responses.appendChild(item);
      }

      // content_meet submits via Enter keydown on the focused input AND a
      // belt-and-suspenders submit.click() ~150ms later. Honour both.
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') answer();
      });
      submit.addEventListener('click', answer);
    })();
  </script>
</body>
</html>`;

// ── OFF-state fake Meet ──────────────────────────────────────────────────────
// Reproduces Meet's 2026-06 "Ask Gemini not started" state so the e2e can drive
// content_meet's autoActivateGemini() end-to-end with PLAIN clicks (no CDP/hover):
//   • button[jsname="wptEcf"] (icon `spark_off`, aria "Gemini can't answer…")
//   • clicking it surfaces a "Start now" card: button[jsname="R6SlF"] >
//     span[jsname="V67aGc"]>Start now   (exactly the live shape)
//   • clicking "Start now" opens the Ask Gemini panel (input in viewport) and
//     swaps the toggle to its active state (button[jsname="J4YcA"]).
// If autoActivate mis-detects the toggle or the "Start now" control, the panel
// input never appears and the test fails — guarding the whole activation path.
const FAKE_MEET_OFF_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Meet - Test Meeting</title>
  <style>
    html, body { margin: 0; height: 100%; }
    aside[aria-label="Side panel"] {
      position: fixed; top: 0; right: 0; width: 360px; height: 100%;
      box-sizing: border-box; padding: 12px; background: #fff;
    }
    div[aria-label="Ask Gemini"] { display: block; width: 320px; min-height: 40px; border: 1px solid #888; }
    div[aria-label="Call controls"] { position: fixed; bottom: 0; left: 0; width: 100%; height: 64px; }
    #gemini-card { position: fixed; bottom: 80px; left: 12px; }
  </style>
</head>
<body>
  <div aria-label="Call controls">
    <button aria-label="Turn off microphone">Mic</button>
    <button aria-label="Turn off camera">Cam</button>
    <!-- OFF-state Ask Gemini toggle (the genuine control autoActivate must click) -->
    <button jsname="wptEcf" aria-label="Gemini can't answer your questions at the moment">
      <i class="google-symbols notranslate">spark_off</i>
    </button>
    <!-- A DIFFERENT feature that must NOT be mistaken for the Ask Gemini toggle -->
    <div role="button" jsname="ocqpFe"><i class="google-symbols">pen_spark</i>Take notes with Gemini</div>
    <button aria-label="Leave call">Leave call</button>
  </div>
  <div id="mount"></div>

  <script>
    (function () {
      var mount = document.getElementById('mount');
      var toggle = document.querySelector('button[jsname="wptEcf"]');

      // Click the OFF toggle → surface the "Start now" card (live DOM shape).
      toggle.addEventListener('click', function () {
        if (document.querySelector('button[jsname="R6SlF"]')) return; // idempotent
        var card = document.createElement('div');
        card.id = 'gemini-card';
        card.innerHTML = '<button jsname="R6SlF"><span jsname="V67aGc">Start now</span></button>';
        mount.appendChild(card);
        card.querySelector('button[jsname="R6SlF"]').addEventListener('click', startGemini);
      });

      // Click "Start now" → open the panel (input in viewport) + swap to active toggle.
      function startGemini() {
        var card = document.getElementById('gemini-card');
        if (card) card.remove();
        toggle.outerHTML = '<button jsname="J4YcA" aria-label="Gemini uses meeting conversations to answer questions"></button>';
        var aside = document.createElement('aside');
        aside.setAttribute('aria-label', 'Side panel');
        aside.innerHTML = '<div aria-label="Ask Gemini" contenteditable="true" role="textbox"></div>'
          + '<button aria-label="Submit">Submit</button>';
        document.body.appendChild(aside);
      }
    })();
  </script>
</body>
</html>`;

// Start a fake-Meet HTTP server on an ephemeral port (match patterns ignore the
// port). Serves the fake page for any path. Returns { server, port, url } where
// url uses a Meet-style room-code path so extractMeetingCode() has something real.
function startFakeMeet(html = FAKE_MEET_HTML) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    // Track live sockets so close() can destroy keep-alive connections instead of
    // hanging until Chromium drops them (which can outlast the test teardown).
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server._sockets = sockets;
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      // localhost (not 127.0.0.1) so the URL matches the http://localhost/* pattern.
      const url = `http://localhost:${port}/abc-defg-hij`;
      resolve({ server, port, url });
    });
  });
}

function closeFakeMeet(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    // Destroy any lingering keep-alive sockets first so server.close() resolves
    // promptly rather than waiting on Chromium's connection pool.
    if (server._sockets) {
      for (const sock of server._sockets) { try { sock.destroy(); } catch (_) {} }
      server._sockets.clear();
    }
    server.close(() => resolve());
  });
}

module.exports = { startFakeMeet, closeFakeMeet, FAKE_MEET_HTML, FAKE_MEET_OFF_HTML, SENTINEL_TRANSCRIPT };
