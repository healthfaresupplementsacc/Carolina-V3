#!/usr/bin/env python3
# ============================================================================
#  PRINT MONITOR (print/printmon.py) — 2026-07-15
#  Runs on the shared print computer (.28). Watches EVERY print job on every
#  printer and captures, per job:
#    - printed document / file name        (Get-PrintJob DocumentName)
#    - printer used                        (event 842 / Get-Printer)
#    - who printed (Windows user)          (Get-PrintJob UserName)
#    - pages, COPIES, total sheets         (TotalPages x Copies from event 805)
#    - submitted time, completed time, DURATION (how long it took to print)
#    - when the printing PROGRAM was first opened that day (process start time
#      of the app whose window/name matches the doc, best-effort)
#    - status (printed OK / failed / stuck) + error code
#  Delivers each finished job INSTANTLY to:
#    1) the Dashboard (Railway) via HTTP POST         (print.config.json: dashboard_url + token)
#    2) Slack #admin-orin                             (reuses camera-viewer/slack_notify.py if present)
#    3) a durable local JSONL log                     (print/printlog.jsonl)
#
#  Data sources (both, correlated by JobId):
#    * PrintService/Operational event log (must be ENABLED — we enable it on start): gives Copies,
#      Printer, driver, error code, and the job lifecycle timestamps.
#    * Get-PrintJob polling: gives DocumentName, UserName, TotalPages, SubmittedTime, JobStatus, Size
#      WHILE the job is in the queue (jobs are briefly "Retained" after completion, so we can read them).
#  We poll the queue ~every 2s; when a JobId we saw disappears/completes, we finalize + ship it.
# ============================================================================
import os, sys, json, time, subprocess, threading, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(BASE, 'print.config.json')
LOG_PATH = os.path.join(BASE, 'printlog.jsonl')
TRIGGER  = os.path.join(BASE, 'trigger.json')     # printmon -> popup: ask who printed this job
OPERATOR = os.path.join(BASE, 'operator.json')    # popup -> printmon: the chosen operator name
PRESENCE = os.path.join(BASE, 'presence.json')    # popup -> printmon: keyboard/mouse presence

def load_cfg():
    try:
        with open(CFG_PATH) as f: return json.load(f)
    except Exception:
        return {}
CFG = load_cfg()
DASHBOARD_URL = CFG.get('dashboard_url', '')          # e.g. https://productionlineservice-production.up.railway.app/api/print-event
DASHBOARD_TOKEN = CFG.get('dashboard_token', '')      # shared secret sent as X-Print-Token
POLL = float(CFG.get('poll_sec', 2.0))
SLACK = bool(CFG.get('slack', True))                  # post to #admin-orin
COMPUTER = CFG.get('computer_name', os.environ.get('COMPUTERNAME', 'print-pc'))

# optional slack via the camera system's poster (same bot token, same #admin-orin)
slack_notify = None
for p in (r'C:\ProgramData\MediaServer\camera-viewer', r'C:\Users\Bruno\Documents\Claude\Camera\camera-viewer'):
    if os.path.isdir(p):
        sys.path.insert(0, p)
        try:
            import slack_notify as _sn; slack_notify = _sn; break
        except Exception:
            slack_notify = None

PS = ['powershell', '-NoProfile', '-NonInteractive', '-Command']

def ps(cmd, timeout=20):
    try:
        r = subprocess.run(PS + [cmd], capture_output=True, timeout=timeout,
                           creationflags=0x08000000)  # CREATE_NO_WINDOW
        return r.stdout.decode('utf-8', 'ignore')
    except Exception:
        return ''

def enable_log():
    ps("""$c=New-Object System.Diagnostics.Eventing.Reader.EventLogConfiguration('Microsoft-Windows-PrintService/Operational');
           if(-not $c.IsEnabled){ $c.IsEnabled=$true; $c.MaximumSizeInBytes=20MB; $c.SaveChanges() }""")

def snapshot_jobs():
    """Current print jobs across ALL printers -> {jobid: {...}}. Includes 'Retained' (just-finished) jobs."""
    out = ps(r"""
$printers = Get-Printer | Select-Object -ExpandProperty Name
$rows = foreach($p in $printers){
  Get-PrintJob -PrinterName $p -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      JobId=$_.Id; Printer=$p; Document=$_.DocumentName; User=$_.UserName;
      Pages=$_.TotalPages; PagesPrinted=$_.PagesPrinted; Size=$_.Size;
      Submitted=($_.SubmittedTime).ToString('o'); Status=[string]$_.JobStatus
    }
  }
}
$rows | ConvertTo-Json -Compress -Depth 3
""")
    try:
        data = json.loads(out) if out.strip() else []
        if isinstance(data, dict): data = [data]
        return {int(j['JobId']): j for j in data if j.get('JobId') is not None}
    except Exception:
        return {}

def event_extras(jobid):
    """Copies + printer + error from the operational log for this JobId (event 805 has Copies, 842 has Printer/error)."""
    out = ps(f"""
$copies=$null; $printer=$null; $err=$null; $rendered=$null; $spooled=$null
Get-WinEvent -LogName 'Microsoft-Windows-PrintService/Operational' -MaxEvents 200 -ErrorAction SilentlyContinue | ForEach-Object {{
  $x=[xml]$_.ToXml(); $ud=$x.Event.UserData
  if($ud){{ $node=$ud.FirstChild; $jid=$node.JobId
    if("$jid" -eq "{jobid}"){{
      if($_.Id -eq 805){{ $copies=$node.Copies; $rendered=$_.TimeCreated.ToString('o') }}
      if($_.Id -eq 800){{ $spooled=$_.TimeCreated.ToString('o') }}
      if($_.Id -eq 842){{ $printer=$node.Printer; $err=$node.ErrorCode }}
    }}
  }}
}}
[pscustomobject]@{{Copies=$copies;Printer=$printer;Error=$err;Rendered=$rendered;Spooled=$spooled}} | ConvertTo-Json -Compress
""")
    try: return json.loads(out) if out.strip() else {}
    except Exception: return {}

def app_open_time(doc):
    """Best-effort: when was the printing PROGRAM opened? Match the doc name's app hint (e.g. 'X - Notepad'
    -> notepad) to a running process' StartTime; else the newest matching-ish process. Returns ISO or None."""
    hint = ''
    if doc and ' - ' in doc:
        hint = doc.rsplit(' - ', 1)[-1].strip()      # 'Invoice - Adobe Acrobat' -> 'Adobe Acrobat'
    out = ps(f"""
$hint='{hint.replace("'", "''")}'
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.MainWindowTitle -or $_.Path }}
$m = $null
if($hint){{ $m = $procs | Where-Object {{ $_.Description -like "*$hint*" -or $_.ProcessName -like "*$($hint.Split(' ')[0])*" -or $_.MainWindowTitle -like "*$hint*" }} | Sort-Object StartTime | Select-Object -First 1 }}
if($m){{ $m.StartTime.ToString('o') }} else {{ '' }}
""")
    v = out.strip()
    return v or None

_shipped = set()
def ship(job):
    jid = job.get('id')
    if jid in _shipped: return
    _shipped.add(jid)
    # 1) durable local log
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f: f.write(json.dumps(job) + '\n')
    except Exception: pass
    # 2) Dashboard (Railway) POST — instant
    if DASHBOARD_URL:
        try:
            body = json.dumps(job).encode()
            req = urllib.request.Request(DASHBOARD_URL, data=body,
                headers={'Content-Type': 'application/json', 'X-Print-Token': DASHBOARD_TOKEN})
            urllib.request.urlopen(req, timeout=8).read()
        except Exception as e:
            print('dashboard POST failed:', e, flush=True)
    # 3) Slack #admin-orin
    if SLACK and slack_notify:
        sheets = (job.get('pages') or 0) * (job.get('copies') or 1)
        dur = job.get('duration_sec')
        durs = f"{dur}s" if dur is not None else "?"
        op = job.get('operator') or 'Unknown'
        sess = job.get('session_active_sec')
        sess_s = f" · no PC há ~{sess//60}min" if isinstance(sess, int) and sess >= 60 else ""
        txt = (f":printer: *Impressão* — *{job.get('document','?')}*\n"
               f":bust_in_silhouette: *{op}*  (usuário Windows: {job.get('user','?')}){sess_s}\n"
               f"impressora: {job.get('printer','?')} · "
               f"{job.get('pages','?')} pág × {job.get('copies',1)} cópia(s) = {sheets} folhas\n"
               f"início: {job.get('submitted','?')} · durou: {durs} · status: {job.get('status','?')}"
               + (f" · :warning: erro {job.get('error')}" if job.get('error') and job.get('error') not in ('0x0','0') else ""))
        try: slack_notify.post_text(txt)
        except Exception: pass
    print('shipped print job', jid, job.get('document'), flush=True)

GATE = bool(CFG.get('gate_until_named', True))   # HARD GATE: pause each job until a name is picked
GATE_MAX_HOLD = int(CFG.get('gate_max_hold_sec', 330))   # fail-safe: never hold a job longer than this
_released = set()

def _ask_operator(jid, j):
    """Write the trigger file so the desktop popup (printpopup.py, user session) asks who printed."""
    try:
        with open(TRIGGER, 'w') as f:
            json.dump({'job_id': int(jid), 'document': j.get('Document', ''),
                       'printer': j.get('Printer', ''), 'gate': GATE, 'ts': int(time.time())}, f)
    except Exception: pass

def _pause_job(printer, jid):
    """Hold the print job in the queue so nothing prints until a name is chosen."""
    if not printer: return
    p = printer.replace("'", "''")
    ps(f"Suspend-PrintJob -PrinterName '{p}' -ID {int(jid)} -EA SilentlyContinue; "
       f"if(-not $?){{ (Get-WmiObject Win32_PrintJob | Where-Object {{ $_.JobId -eq {int(jid)} }}).Pause() | Out-Null }}",
       timeout=12)

def _resume_job(printer, jid):
    if not printer: return
    p = printer.replace("'", "''")
    ps(f"Resume-PrintJob -PrinterName '{p}' -ID {int(jid)} -EA SilentlyContinue; "
       f"if(-not $?){{ (Get-WmiObject Win32_PrintJob | Where-Object {{ $_.JobId -eq {int(jid)} }}).Resume() | Out-Null }}",
       timeout=12)

def _peek_operator(jid):
    """Non-blocking read of the popup's answer for this job (does NOT wait). '' if not answered."""
    try:
        with open(OPERATOR) as f: op = json.load(f)
        if op.get('job_id') == int(jid):
            return op.get('operator') or ''
    except Exception: pass
    return ''

def _get_operator(jid, wait_sec=6):
    """Read the popup's answer for this job (poll operator.json up to wait_sec). 'Unknown' if none."""
    deadline = time.time() + wait_sec
    while time.time() < deadline:
        try:
            with open(OPERATOR) as f: op = json.load(f)
            if op.get('job_id') == int(jid):
                return op.get('operator') or 'Unknown'
        except Exception: pass
        time.sleep(0.5)
    return 'Unknown'

def _presence():
    """Current keyboard/mouse presence written by the desktop app: how long they've been active + idle."""
    try:
        with open(PRESENCE) as f: return json.load(f)
    except Exception:
        return {}

def main():
    enable_log()
    print(f'printmon watching all printers on {COMPUTER} (poll {POLL}s)', flush=True)
    seen = {}                    # jobid -> last snapshot we saw (to detect disappearance = completion)
    first_seen = {}              # jobid -> when we first saw it (fallback submit time)
    app_open = {}                # jobid -> program open time (captured while active)
    while True:
        try:
            cur = snapshot_jobs()
            now = time.time()
            for jid, j in cur.items():
                if jid not in first_seen:
                    first_seen[jid] = now
                    app_open[jid] = app_open_time(j.get('Document', ''))   # capture NOW while the app is open
                    if GATE:
                        _pause_job(j.get('Printer',''), jid)               # HARD GATE: hold the job until a name is picked
                    _ask_operator(jid, j)                                  # show the full-screen "who is printing?" gate
                seen[jid] = j
                # release a held job the moment its operator is answered — OR after GATE_MAX_HOLD as a
                # fail-safe so a stuck popup can NEVER permanently block a printer.
                if GATE and jid not in _released:
                    op = _peek_operator(jid)
                    held_too_long = (now - first_seen.get(jid, now)) > GATE_MAX_HOLD
                    if op or held_too_long:
                        _resume_job(j.get('Printer',''), jid); _released.add(jid)
                        if held_too_long and not op:
                            print(f'gate fail-safe: released job {jid} after {GATE_MAX_HOLD}s unanswered', flush=True)
            # any job we saw before that is now GONE (or marked complete/deleted) -> finalize + ship
            for jid in list(seen.keys()):
                j = cur.get(jid)
                status = (j or seen[jid]).get('Status', '') or ''
                done = (jid not in cur) or ('Complete' in status) or ('Printed' in status) or ('Deleted' in status) or ('Error' in status)
                if not done:
                    continue
                snap = seen.pop(jid); cur.pop(jid, None)
                ex = event_extras(jid)
                # timing
                submitted = snap.get('Submitted')
                sub_ts = _iso_ts(submitted) or first_seen.get(jid, now)
                dur = max(0, int(now - sub_ts)) if sub_ts else None
                job = {
                    'id': int(jid),
                    'computer': COMPUTER,
                    'document': snap.get('Document'),
                    'printer': ex.get('Printer') or snap.get('Printer'),
                    'user': snap.get('User'),
                    'pages': _int(snap.get('Pages')),
                    'copies': _int(ex.get('Copies')) or 1,
                    'sheets': (_int(snap.get('Pages')) or 0) * (_int(ex.get('Copies')) or 1),
                    'size_bytes': _int(snap.get('Size')),
                    'submitted': submitted,
                    'completed_ts': int(now),
                    'duration_sec': dur,
                    'app_opened': app_open.get(jid),
                    'status': 'error' if ('Error' in status) else ('completed'),
                    'error': ex.get('Error'),
                    'operator': _get_operator(jid),          # WHO printed (from the popup); 'Unknown' if unanswered
                    'session_active_sec': (_presence().get('active_streak_sec')),  # how long they've been at the PC
                    'ts': int(now),
                }
                ship(job)
                first_seen.pop(jid, None); app_open.pop(jid, None)
        except Exception as e:
            print('printmon loop err:', e, flush=True)
        time.sleep(POLL)

def _int(v):
    try: return int(v)
    except Exception: return None

def _iso_ts(s):
    if not s: return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None

def _single_instance():
    """Guard de INSTANCIA UNICA (Bruno 07-27): impede 2 printmon rodando ao mesmo
    tempo (a causa do spam '3x Melatonin' — 2 processos notificando o mesmo job).
    Se ja existe um, este SAI na hora. Mutex nomeado no kernel do Windows."""
    import ctypes
    k32 = ctypes.windll.kernel32
    k32.CreateMutexW(None, False, 'Global\\HF_Printmon_SingleInstance')
    if k32.GetLastError() == 183:   # ERROR_ALREADY_EXISTS
        try:
            with open(r'C:\ProgramData\MediaServer\logs\printmon.out.log', 'a', encoding='utf-8') as f:
                f.write(time.strftime('%Y-%m-%d %H:%M:%S') + '  ja ha um printmon rodando -> saindo\n')
        except Exception:
            pass
        sys.exit(0)


if __name__ == '__main__':
    _single_instance()
    main()
