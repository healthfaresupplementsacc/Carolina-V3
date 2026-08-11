# -*- coding: utf-8 -*-
"""
HealthFare - TRAVA de kiosk da Estacao de Impressao (.28). Bruno 2026-07-16.
Cobre o Windows em fullscreen ate a pessoa por o PIN (mesmo do /op). Ao logar ->
abre a task "Impressao de Labels" e LIBERA o desktop; re-tranca em 10 min. OTHER
pra nao-funcionario. PIN de 4 digitos ENTRA SOZINHO (sem clicar OK), igual /op.

SESSION 1 como 'printer' (session_launcher.ps1). Kill-switch: arquivo lock.off ->
nao tranca / destranca. Recuperavel via SSH (camctl). Se crashar, FAIL-OPEN (sai,
desktop livre) pra nunca prender o PC.
"""
import os, sys, json, time, logging, threading, ctypes, urllib.request, urllib.error, tkinter as tk
from ctypes import wintypes

BASE = 'https://productionlineservice-production.up.railway.app'
DIR = r'C:\ProgramData\MediaServer\print'
LOGS = os.path.join(DIR, 'logs')
OFF = os.path.join(DIR, 'lock.off')
RELOCK_MS = 10 * 60 * 1000
IDLE_LIMIT_MS = 5 * 60 * 1000   # tempo ativo PARA de contar apos 5min sem input (Bruno 07-24)
BLUE = '#0f4c92'; BLUE2 = '#2f7ae0'; INK = '#0c2545'

os.makedirs(LOGS, exist_ok=True)
logging.basicConfig(filename=os.path.join(LOGS, 'printlock.log'), level=logging.INFO,
                    format='%(asctime)s %(message)s')
log = logging.getLogger('printlock')

# ---- LOCAL SESSION HISTORY (2026-07-21, Bruno) --------------------------------------------------
# Who used this PC, kept locally so the idle Adobe-cleanup can report "these people used the PC and
# the LAST one left the file open". The Dashboard also gets logins, but a local copy means the report
# works even if the API is unreachable. One JSON line per event; trimmed to the last 200.
SESSIONS_F = os.path.join(DIR, 'sessions.json')
def record_session(event, who):
    try:
        try:
            with open(SESSIONS_F, encoding='utf-8-sig') as f: hist = json.load(f)
            if not isinstance(hist, list): hist = []
        except Exception: hist = []
        hist.append({'ts': int(time.time()), 'event': event, 'who': who or 'desconhecido'})
        hist = hist[-200:]
        tmp = SESSIONS_F + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f: json.dump(hist, f)
        os.replace(tmp, SESSIONS_F)
    except Exception as e:
        log.info('record_session err: %s', e)

# ===== BLOQUEIO DE TECLAS (Bruno 07-16: bloqueia tudo MENOS o Gerenciador de =====
# Tarefas). Hook de baixo nivel WH_KEYBOARD_LL num thread com message loop proprio.
# So engole as teclas de FUGA quando LOCKED['on']; libera geral quando desbloqueado.
LOCKED = {'on': True}
_hook_id = None
_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32
WH_KEYBOARD_LL = 13
WM_KEYDOWN, WM_SYSKEYDOWN = 0x0100, 0x0104
VK_TAB, VK_ESCAPE, VK_F4 = 0x09, 0x1B, 0x73
VK_LWIN, VK_RWIN = 0x5B, 0x5C
VK_SHIFT, VK_CONTROL, VK_MENU = 0x10, 0x11, 0x12


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [('vkCode', wintypes.DWORD), ('scanCode', wintypes.DWORD),
                ('flags', wintypes.DWORD), ('time', wintypes.DWORD),
                ('dwExtraInfo', ctypes.POINTER(wintypes.ULONG))]


HOOKPROC = ctypes.CFUNCTYPE(ctypes.c_long, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

# argtypes/restype OBRIGATORIOS em 64-bit (senao o ponteiro do callback trunca e
# SetWindowsHookExW devolve NULL -> hook nao instala).
_user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
_user32.SetWindowsHookExW.restype = ctypes.c_void_p
_user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
_user32.CallNextHookEx.restype = wintypes.LPARAM
_user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, ctypes.c_uint, ctypes.c_uint]
_kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
_kernel32.GetModuleHandleW.restype = wintypes.HMODULE


# tempo ATIVO (teclado/mouse) via GetLastInputInfo — pro "quanto ficou mexendo no PC".
class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.UINT), ('dwTime', wintypes.DWORD)]


_kernel32.GetTickCount.restype = wintypes.DWORD


def _idle_ms():
    li = LASTINPUTINFO(); li.cbSize = ctypes.sizeof(li)
    if _user32.GetLastInputInfo(ctypes.byref(li)):
        return _kernel32.GetTickCount() - li.dwTime
    return 999999


def _held(vk):
    return bool(_user32.GetAsyncKeyState(vk) & 0x8000)


def _keyproc(nCode, wParam, lParam):
    try:
        if nCode == 0 and LOCKED['on'] and wParam in (WM_KEYDOWN, WM_SYSKEYDOWN):
            vk = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT))[0].vkCode
            alt, ctrl, shift = _held(VK_MENU), _held(VK_CONTROL), _held(VK_SHIFT)
            block = False
            if vk in (VK_LWIN, VK_RWIN):
                block = True                              # tecla Windows
            elif vk == VK_TAB and alt:
                block = True                              # Alt+Tab
            elif vk == VK_F4 and alt:
                block = True                              # Alt+F4
            elif vk == VK_ESCAPE and (alt or ctrl):
                # Ctrl+Shift+Esc = Gerenciador de Tarefas -> LIBERA (regra Bruno)
                if not (ctrl and shift):
                    block = True                          # Alt+Esc / Ctrl+Esc
            if block:
                return 1
    except Exception:
        pass
    return _user32.CallNextHookEx(_hook_id, nCode, wParam, lParam)


_keyproc_ptr = HOOKPROC(_keyproc)


def _hook_loop():
    global _hook_id
    _hook_id = _user32.SetWindowsHookExW(WH_KEYBOARD_LL, _keyproc_ptr, _kernel32.GetModuleHandleW(None), 0)
    log.info('keyboard hook instalado: %s', bool(_hook_id))
    msg = wintypes.MSG()
    while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        _user32.TranslateMessage(ctypes.byref(msg))
        _user32.DispatchMessageW(ctypes.byref(msg))


def http(path, body=None, bearer=None, session=None, base=BASE, timeout=12):
    url = base + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method='POST' if data is not None else 'GET')
    req.add_header('Content-Type', 'application/json')
    if bearer: req.add_header('Authorization', 'Bearer ' + bearer)
    if session: req.add_header('X-Session-Token', session)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try: j = json.loads(e.read().decode() or '{}')
        except Exception: j = {}
        return e.code, j
    except Exception as e:
        return 0, {'error': str(e)}


def page_token():
    try:
        with urllib.request.urlopen(BASE + '/op/config.js', timeout=10) as r:
            txt = r.read().decode()
        i, j = txt.find('{'), txt.rfind('}')
        return (json.loads(txt[i:j + 1]) or {}).get('pageToken', '') if i >= 0 else ''
    except Exception as e:
        log.info('page_token erro: %s', e); return ''


class Lock:
    def __init__(self, root):
        self.root = root
        self.tok = ''
        self.pin = ''
        self.session = None
        self.who = None                       # display name of whoever unlocked (for the session history)
        self.relock_job = None
        self.active_sec = 0
        self.hb_job = None
        root.title('HealthFare')
        root.attributes('-fullscreen', True)
        root.attributes('-topmost', True)
        root.overrideredirect(True)
        root.configure(bg=BLUE)
        root.protocol('WM_DELETE_WINDOW', lambda: None)
        root.bind('<Alt-F4>', lambda e: 'break')
        # fundo em gradiente azul (mimica o ambiente do /op)
        self.bg = tk.Canvas(root, highlightthickness=0, bd=0)
        self.bg.pack(fill='both', expand=True)
        root.update_idletasks()
        self._gradient()
        self.card = tk.Frame(self.bg, bg='white')
        self.bg.create_window(root.winfo_screenwidth() // 2, root.winfo_screenheight() // 2,
                              window=self.card, anchor='center')
        self.build_pin()
        self.tok = page_token()
        self.watch_killswitch()
        self.root.after(20000, self.heartbeat)      # tempo ativo (teclado/mouse)

    def heartbeat(self):
        # TEMPO ATIVO (Bruno 07-24): comeca a contar quando a pessoa loga com o PIN,
        # conta enquanto mouse/teclado se mexem, PARA quando fica idle >5min. E o tempo
        # ativo TOTAL da pessoa naquele PC (acumula a sessao toda; NAO zera no re-lock).
        # So zera quando OUTRA pessoa loga. Conta mesmo com a tela bloqueada por timer —
        # o que importa e o INPUT, nao o estado da tela.
        try:
            if self.session:
                if _idle_ms() < IDLE_LIMIT_MS:      # mexeu nos ultimos 5min → ativo
                    self.active_sec += 20
                http('/api/v3/op/print-heartbeat', {'active_sec': self.active_sec}, bearer=self.tok, session=self.session)
        except Exception:
            pass
        self.hb_job = self.root.after(20000, self.heartbeat)

    def _gradient(self):
        w = self.root.winfo_screenwidth() or 1920
        h = self.root.winfo_screenheight() or 1080
        top = (14, 42, 92); bot = (47, 122, 224)   # BLUE -> BLUE2
        steps = 120
        for i in range(steps):
            r = int(top[0] + (bot[0] - top[0]) * i / steps)
            g = int(top[1] + (bot[1] - top[1]) * i / steps)
            b = int(top[2] + (bot[2] - top[2]) * i / steps)
            self.bg.create_rectangle(0, h * i // steps, w, h * (i + 1) // steps + 1,
                                     outline='', fill='#%02x%02x%02x' % (r, g, b))

    # ---------- PIN ----------
    def build_pin(self):
        for w in self.card.winfo_children(): w.destroy()
        self.card.configure(padx=54, pady=46)
        tk.Label(self.card, text='HealthFare', font=('Segoe UI', 32, 'bold'), fg=BLUE, bg='white').pack()
        tk.Label(self.card, text='ESTACAO DE IMPRESSAO', font=('Segoe UI', 11, 'bold'),
                 fg='#6c819b', bg='white').pack(pady=(2, 20))
        self.dots = tk.Label(self.card, text=self._dots(), font=('Consolas', 30, 'bold'), fg=BLUE, bg='white')
        self.dots.pack()
        self.errlbl = tk.Label(self.card, text='', font=('Segoe UI', 12, 'bold'), fg='#c0352b', bg='white', height=1)
        self.errlbl.pack(pady=(8, 14))
        grid = tk.Frame(self.card, bg='white'); grid.pack()
        for i, k in enumerate(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK']):
            b = tk.Button(grid, text=k, width=5, height=2, font=('Segoe UI', 18, 'bold'),
                          fg='white' if k == 'OK' else INK, bg='#19a463' if k == 'OK' else '#eef2f8',
                          activebackground='#d7e3f4', bd=0, relief='flat',
                          command=lambda kk=k: self.key(kk))
            b.grid(row=i // 3, column=i % 3, padx=8, pady=8, ipadx=8)
        tk.Label(self.card, text='Digite seu PIN de 4 digitos para imprimir',
                 font=('Segoe UI', 10), fg='#566681', bg='white').pack(pady=(18, 0))
        tk.Button(self.card, text='Nao sou funcionario - OTHER', font=('Segoe UI', 10, 'bold'),
                  fg='#42566f', bg='white', bd=1, relief='solid', command=self.to_other).pack(pady=(14, 0))

    def _dots(self):
        return '   '.join(['●' if i < len(self.pin) else '○' for i in range(4)])

    def key(self, k):
        if k == 'C':
            self.pin = self.pin[:-1]
        elif k == 'OK':
            if len(self.pin) == 4: self.submit_pin()
            return
        elif k.isdigit() and len(self.pin) < 4:
            self.pin += k
            self.errlbl.configure(text=''); self.dots.configure(text=self._dots())
            if len(self.pin) == 4:                      # ENTRA SOZINHO no 4o digito
                self.root.after(120, self.submit_pin)
            return
        self.errlbl.configure(text=''); self.dots.configure(text=self._dots())

    def submit_pin(self):
        if len(self.pin) != 4: return
        st, j = http('/api/v3/op/auth/login', {'pin': self.pin}, bearer=self.tok)
        if st == 200 and j.get('session_token'):
            self.session = j['session_token']; who = (j.get('person') or {}).get('display_name', 'operador')
            log.info('LOGIN ok: %s', who)
            try: http('/api/v3/op/print-login', {}, bearer=self.tok, session=self.session)
            except Exception: pass
            return self.unlock(who)
        self.pin = ''; msg = 'Muitas tentativas - aguarde' if st == 429 else 'PIN incorreto'
        self.dots.configure(text=self._dots()); self.errlbl.configure(text=msg)
        log.info('LOGIN falhou st=%s %s', st, j.get('error'))

    # ---------- OTHER ----------
    def to_other(self):
        for w in self.card.winfo_children(): w.destroy()
        self.card.configure(padx=46, pady=40)
        oname = tk.StringVar(); owhat = tk.StringVar()
        tk.Label(self.card, text='Quem e voce?', font=('Segoe UI', 22, 'bold'), fg=BLUE, bg='white').pack()
        tk.Label(self.card, text='Diga seu nome e o que vai fazer (obrigatorio)',
                 font=('Segoe UI', 10), fg='#566681', bg='white').pack(pady=(4, 16))
        tk.Label(self.card, text='Seu nome', font=('Segoe UI', 10, 'bold'), fg='#42566f', bg='white', anchor='w').pack(fill='x')
        e1 = tk.Entry(self.card, textvariable=oname, font=('Segoe UI', 15), width=34); e1.pack(pady=(2, 12)); e1.focus_set()
        tk.Label(self.card, text='O que vai fazer?', font=('Segoe UI', 10, 'bold'), fg='#42566f', bg='white', anchor='w').pack(fill='x')
        tk.Entry(self.card, textvariable=owhat, font=('Segoe UI', 15), width=34).pack(pady=(2, 8))
        oerr = tk.Label(self.card, text='', font=('Segoe UI', 11, 'bold'), fg='#c0352b', bg='white'); oerr.pack()

        def go():
            n, w = oname.get().strip(), owhat.get().strip()
            if not n or not w: oerr.configure(text='Preencha nome e o que vai fazer'); return
            http('/api/v3/print/other', {'name': n, 'what': w}, bearer=self.tok)
            log.info('OTHER: %s -> %s', n, w); self.unlock(n)
        row = tk.Frame(self.card, bg='white'); row.pack(pady=(10, 0))
        tk.Button(row, text='Voltar', font=('Segoe UI', 13), fg='#42566f', bg='#eef2f8', bd=0,
                  width=10, height=2, command=self.build_pin).pack(side='left', padx=6)
        tk.Button(row, text='Entrar', font=('Segoe UI', 13, 'bold'), fg='white', bg=BLUE, bd=0,
                  width=14, height=2, command=go).pack(side='left', padx=6)

    # ---------- lock / unlock ----------
    def unlock(self, who):
        log.info('DESBLOQUEADO por %s -> libera desktop', who)
        record_session('login', who)          # local history for the idle-cleanup report
        # TEMPO ATIVO (Bruno 07-24): so ZERA quando muda de PESSOA. Se a MESMA pessoa
        # re-desbloqueia (auto-lock disparou e ela voltou), CONTINUA acumulando — e o
        # tempo ativo dela no PC durante o dia inteiro.
        if who != self.who:
            self.active_sec = 0
        self.who = who
        self.pin = ''
        LOCKED['on'] = False                 # libera as teclas (pessoa usa o PC normal)
        self.root.withdraw()
        if self.relock_job: self.root.after_cancel(self.relock_job)
        self.relock_job = self.root.after(RELOCK_MS, self.relock)

    def relock(self):
        log.info('RE-TRANCA (10 min) -> cobre a tela')
        record_session('logout', getattr(self, 'who', None))   # session ended (screen re-locked)
        LOCKED['on'] = True                  # volta a bloquear as teclas de fuga
        self.pin = ''; self.build_pin()
        self.root.deiconify(); self.root.attributes('-fullscreen', True); self.root.attributes('-topmost', True)
        self.root.lift(); self.root.focus_force()

    def watch_killswitch(self):
        if os.path.exists(OFF):
            log.info('lock.off -> destranca e sai'); self.root.destroy(); os._exit(0)
        self.root.after(2000, self.watch_killswitch)


def main():
    if os.path.exists(OFF):
        log.info('lock.off no start -> nao tranca'); return
    log.info('printlock iniciando')
    LOCKED['on'] = True
    threading.Thread(target=_hook_loop, daemon=True).start()   # bloqueio de teclas
    root = tk.Tk()
    Lock(root)
    root.mainloop()


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log.exception('crash: %s -> FAIL-OPEN', e)
        os._exit(1)
