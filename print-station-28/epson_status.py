# -*- coding: utf-8 -*-
r"""
HealthFare — Leitor de STATUS FISICO da EPSON CW-C8000u (.28). Bruno 2026-07-17.

O problema: o spooler/WMI diz "imprimindo" ~5s e volta pra "ociosa" enquanto a
impressora AINDA imprime do buffer. O evento Windows 307 tambem e o spooler.

A solucao (deep-research fable + teste ao vivo na .28): falar DIRETO com o device
USB da impressora (usbprint.sys, GUID {28d78fad-5a12-11d1-ae5b-0000f803a8c2}) via
SetupDi + CreateFile — esse handle e BIDIRECIONAL (o pipe RAW do spooler so escreve).
Mandamos ESC/Label:
  ~H(SPB,F   info request que passa mesmo com o buffer color cheio
  ~H(SMA,S   Send printer operation status
A impressora responde  \x02^S(SMA,S,XX\x03  onde XX = PR(imprimindo)/IL(ocioso)/
WT/PS/CL/ER. CONFIRMADO ao vivo: respondeu "^S(SMA,S,IL".
A transicao PR->IL e o FIM FISICO exato.

Loop; quando o estado MUDA, POST /api/printer-status (o backend calcula o tempo
fisico PR->IL, grava em print_jobs.print_seconds e dispara "pode coletar" no Slack).
NUNCA iniciar por SSH (usar WMI/scheduled task). Sem deps externas (so ctypes+urllib).
"""
import ctypes
from ctypes import wintypes
import json
import os
import re
import time
import urllib.request

CFG_PATH = r'C:\ProgramData\MediaServer\print\print.config.json'
LOG_PATH = r'C:\ProgramData\MediaServer\logs\epson_status.log'
POLL_SEC = 3
EPSON_VID = 'vid_04b8'   # Seiko Epson

CMD = b'\x7eH(SPB,F\x7eH(SMA,S\x7eH(SEA,E'   # buffer-full + status operacao + status de ERRO
# Pro nosso proposito (fim de impressao + erro real) SO importam 2 estados:
#   PR = imprimindo (o mecanismo esta cuspindo label)
#   qualquer_outra_coisa = ociosa/parada (nao esta imprimindo)
# NAO reportamos WT/PS/CL/ER como estados proprios — isso oscila numa impressora
# parada e vira spam. So 'imprimindo' vs 'ociosa'. Erro so por codigo de MIDIA real.
SMA_RE = re.compile(rb'S\(SMA,S,([A-Z]{2})')
SEA_RE = re.compile(rb'S\(SEA,E,([A-Za-z0-9#]{1,6})')   # status de erro: NE=sem erro; resto=erro
# codigos de erro do ~H(SEA,E -> texto (NE = sem erro, ignora)
SEA_ERR = {
    'FE': 'erro fatal', 'PE': 'sem papel', 'PO': 'sem papel', 'PJ': 'papel atolado',
    'CJ': 'papel atolado', 'JAM': 'papel atolado', 'CO': 'tampa/porta aberta',
    'DO': 'tampa/porta aberta', 'IE': 'trocar cartucho de tinta', 'NI': 'sem tinta',
    'ME': 'caixa de manutencao cheia', 'MR': 'trocar caixa de manutencao',
    'RE': 'erro de recuperacao', 'SE': 'chamar servico', 'CE': 'erro de corte',
    'HE': 'erro no cabecote', 'TE': 'erro de temperatura',
}
# TINTA (~H(QIQ): resposta \x02IQ,<K>,<C>,<M>,<Y>\x03 — ordem K,C,M,Y. Codigos:
#   RH cheio / RM moderado / RL pouco / RN baixo / RR trocar / NA sem cartucho / CI instalado
CMD_INK  = b'\x7eH(QIQ'   # remaining ink (CMYK)
CMD_MBOX = b'\x7eH(QMN'   # maintenance box
CMD_WARN = b'\x7eH(QWN'   # warnings (nozzle clog etc.)
IQ_RE = re.compile(rb'\x02IQ,([A-Z]{2}),([A-Z]{2}),([A-Z]{2}),([A-Z]{2})\x03')
MN_RE = re.compile(rb'\x02MN,([A-Z]{2})\x03')
WN_RE = re.compile(rb'\x02WN((?:,[A-Z0-9]+)*)\x03')
# codigo de nivel -> (rotulo, pct aproximado pra barra, e se e alerta)
INK_LEVEL = {
    'RH': ('cheio', 90), 'RM': ('moderado', 60), 'RL': ('pouco', 30),
    'RN': ('baixo', 12), 'RR': ('trocar', 3), 'NA': ('sem cartucho', 0), 'CI': ('instalado', 100),
}
INK_POLL_SEC = 300   # tinta muda devagar — le a cada 5min
# CONTADOR nao-resetavel de labels impressos (~H(SCN,L) — a VERDADE da maquina.
# O spooler mente pra PDF (Acrobat expande copias internamente -> "1 pagina");
# o contador da EPSON nao. Delta entre ociosa->ociosa = labels fisicos do job.
CMD_COUNTER = b'\x7eH(SCN,L'
CNL_RE = re.compile(rb'S\(SCN,L,(\d+)')
COUNTER_IDLE_POLL_SEC = 30   # atualiza o contador-base a cada 30s quando ociosa
# codigos de erro de MIDIA (SEA) que sao problema de verdade -> avisa. O resto (#NA,
# oscilacoes) e ignorado. Ajustar conforme os codigos reais aparecerem no log.
MEDIA_ERR = {
    'PE': 'sem papel', 'PO': 'sem papel', 'NP': 'sem papel',
    'JAM': 'papel atolado', 'PJ': 'papel atolado', 'CJ': 'papel atolado',
    'IO': 'sem tinta', 'NI': 'sem tinta',
    'CO': 'porta aberta', 'DO': 'porta aberta',
}

GUID_USBPRINT = '{28D78FAD-5A12-11D1-AE5B-0000F803A8C2}'
DIGCF_PRESENT = 0x02
DIGCF_DEVICEINTERFACE = 0x10
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_RW = 3
OPEN_EXISTING = 3
INVALID = wintypes.HANDLE(-1).value

setupapi = ctypes.WinDLL('setupapi', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)


class GUID(ctypes.Structure):
    _fields_ = [('Data1', wintypes.DWORD), ('Data2', wintypes.WORD), ('Data3', wintypes.WORD), ('Data4', ctypes.c_ubyte * 8)]
    def __init__(self, s):
        s = s.strip('{}'); p = s.split('-')
        self.Data1 = int(p[0], 16); self.Data2 = int(p[1], 16); self.Data3 = int(p[2], 16)
        rest = p[3] + p[4]
        for i in range(8):
            self.Data4[i] = int(rest[i*2:i*2+2], 16)


class SP_DID(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.DWORD), ('InterfaceClassGuid', GUID), ('Flags', wintypes.DWORD), ('Reserved', ctypes.POINTER(wintypes.ULONG))]


class SP_DIDD(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.DWORD), ('DevicePath', wintypes.WCHAR * 512)]


setupapi.SetupDiGetClassDevsW.restype = wintypes.HANDLE
setupapi.SetupDiGetClassDevsW.argtypes = [ctypes.POINTER(GUID), wintypes.LPCWSTR, wintypes.HWND, wintypes.DWORD]
setupapi.SetupDiEnumDeviceInterfaces.restype = wintypes.BOOL
setupapi.SetupDiEnumDeviceInterfaces.argtypes = [wintypes.HANDLE, wintypes.LPVOID, ctypes.POINTER(GUID), wintypes.DWORD, ctypes.POINTER(SP_DID)]
setupapi.SetupDiGetDeviceInterfaceDetailW.restype = wintypes.BOOL
setupapi.SetupDiGetDeviceInterfaceDetailW.argtypes = [wintypes.HANDLE, ctypes.POINTER(SP_DID), ctypes.POINTER(SP_DIDD), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
setupapi.SetupDiDestroyDeviceInfoList.restype = wintypes.BOOL
setupapi.SetupDiDestroyDeviceInfoList.argtypes = [wintypes.HANDLE]
kernel32.CreateFileW.restype = wintypes.HANDLE
kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel32.WriteFile.restype = wintypes.BOOL
kernel32.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
kernel32.ReadFile.restype = wintypes.BOOL
kernel32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CreateMutexW.restype = wintypes.HANDLE
kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S') + '  ' + msg + '\n')
    except Exception:
        pass


def load_cfg():
    with open(CFG_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def epson_usb_paths():
    guid = GUID(GUID_USBPRINT)
    hdev = setupapi.SetupDiGetClassDevsW(ctypes.byref(guid), None, None, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE)
    if hdev == INVALID:
        return []
    paths = []; i = 0
    did = SP_DID(); did.cbSize = ctypes.sizeof(SP_DID)
    while setupapi.SetupDiEnumDeviceInterfaces(hdev, None, ctypes.byref(guid), i, ctypes.byref(did)):
        req = wintypes.DWORD(0)
        setupapi.SetupDiGetDeviceInterfaceDetailW(hdev, ctypes.byref(did), None, 0, ctypes.byref(req), None)
        detail = SP_DIDD(); detail.cbSize = 8
        if setupapi.SetupDiGetDeviceInterfaceDetailW(hdev, ctypes.byref(did), ctypes.byref(detail), req, None, None):
            if EPSON_VID in detail.DevicePath.lower():
                paths.append(detail.DevicePath)
        i += 1
    setupapi.SetupDiDestroyDeviceInfoList(hdev)
    return paths


def printer_name_for(path):
    """Nome amigavel da impressora (pro backend casar com print_jobs.printer).
    Mapeia pelo VID/PID -> pega o primeiro nome de impressora EPSON conhecido."""
    # simples: a .28 so tem uma EPSON; devolve o nome exato do spooler.
    return 'EPSON CW-C8000u (Copy 1)'


def query_state(path):
    """CreateFile bidirecional + ESC/Label. Devolve (rotulo, erro_flag, raw) ou (None,...)."""
    h = kernel32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_RW, None, OPEN_EXISTING, 0, None)
    if h == INVALID:
        return None, None, 'open_fail_%d' % ctypes.get_last_error()
    try:
        written = wintypes.DWORD(0)
        kernel32.WriteFile(h, CMD, len(CMD), ctypes.byref(written), None)
        time.sleep(0.2)
        buf = ctypes.create_string_buffer(1024); read = wintypes.DWORD(0); resp = b''
        for _ in range(6):
            if kernel32.ReadFile(h, buf, 1024, ctypes.byref(read), None) and read.value > 0:
                resp += buf.raw[:read.value]
            else:
                break
            time.sleep(0.06)
        if not resp:
            return None, None, 'no_response'
        m = SMA_RE.search(resp)
        code = m.group(1).decode('ascii') if m else None
        # estado: imprimindo (PR) vs ociosa (tudo mais).
        label = 'imprimindo' if code == 'PR' else 'ociosa'
        # ERRO (Bruno 07-24): via ~H(SEA,E — NE=sem erro; qualquer outro codigo = erro.
        # ANTES o comando de erro nem estava no CMD e o regex olhava SEA,S (errado),
        # entao NUNCA detectava travamento/erro. Agora pega de verdade.
        em = SEA_RE.search(resp)
        err = None
        if em:
            ec = em.group(1).decode('ascii', 'ignore').strip().upper()
            if ec and ec not in ('NE', '#NA', 'NA'):
                err = SEA_ERR.get(ec, 'erro na impressora (' + ec + ')')
        if err:
            label = 'erro'
        return label, err, resp[:80].hex()
    finally:
        kernel32.CloseHandle(h)


def _send_recv(path, cmd, tries=8):
    """Manda um comando e le a resposta pelo device USB. Devolve bytes (ou b'')."""
    h = kernel32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_RW, None, OPEN_EXISTING, 0, None)
    if h == INVALID:
        return b''
    try:
        w = wintypes.DWORD(0)
        kernel32.WriteFile(h, cmd, len(cmd), ctypes.byref(w), None)
        time.sleep(0.2)
        buf = ctypes.create_string_buffer(2048); r = wintypes.DWORD(0); resp = b''
        for _ in range(tries):
            if kernel32.ReadFile(h, buf, 2048, ctypes.byref(r), None) and r.value > 0:
                resp += buf.raw[:r.value]
            else:
                break
            time.sleep(0.06)
        return resp
    finally:
        kernel32.CloseHandle(h)


def query_ink(path):
    """Le tinta CMYK + caixa de manutencao + avisos. Devolve dict ou None."""
    ink = None
    resp = _send_recv(path, CMD_INK)
    m = IQ_RE.search(resp)
    if m:
        cols = ['K', 'C', 'M', 'Y']
        ink = {}
        for i, c in enumerate(cols):
            code = m.group(i + 1).decode('ascii')
            lbl, pct = INK_LEVEL.get(code, ('?', 50))
            ink[c] = {'code': code, 'label': lbl, 'pct': pct}
    # caixa de manutencao
    mbox = None
    mr = MN_RE.search(_send_recv(path, CMD_MBOX))
    if mr:
        code = mr.group(1).decode('ascii')
        lbl, pct = INK_LEVEL.get(code, ('?', 50))
        mbox = {'code': code, 'label': lbl, 'pct': pct}
    # avisos
    warns = []
    wr = WN_RE.search(_send_recv(path, CMD_WARN))
    if wr and wr.group(1):
        warns = [w for w in wr.group(1).decode('ascii').split(',') if w]
    if ink is None and mbox is None and not warns:
        return None
    return {'ink': ink, 'maint_box': mbox, 'warnings': warns}


def query_counter(path):
    """Le o contador nao-resetavel de labels impressos. int ou None."""
    m = CNL_RE.search(_send_recv(path, CMD_COUNTER))
    return int(m.group(1)) if m else None


def post_status(base, token, computer, printer, label, err, raw, ink=None, labels_printed=None):
    url = base.rstrip('/') + '/api/printer-status'
    payload = {'computer': computer, 'printer': printer, 'status_label': label,
               'error_label': err or 'none', 'raw': raw, 'source': 'esclabel_usb'}
    if ink:
        payload['ink'] = ink.get('ink')
        payload['media'] = {'maint_box': ink.get('maint_box'), 'warnings': ink.get('warnings')}
    if labels_printed is not None:
        payload['labels_printed'] = labels_printed   # contagem REAL da maquina (delta do contador)
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST',
                                headers={'X-Print-Token': token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except Exception as e:
        log('post falhou: ' + str(e)); return None


def single_instance():
    """Mutex nomeado (kernel) — garante 1 instancia so. Se ja existe, sai.
    Evita 2 processos brigando pelo CreateFile do device USB (causa de crash
    nativo do ctypes que nem o try/except pega). Bruno 07-17."""
    ERROR_ALREADY_EXISTS = 183
    h = kernel32.CreateMutexW(None, True, 'Global\\HF_EpsonStatus_Reader')
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        log('outra instancia ja roda — saindo')
        return None
    return h  # mantem a ref viva enquanto o processo vive


def run_loop():
    cfg = load_cfg()
    base = cfg['dashboard_url'].replace('/api/print-event', '')
    token = cfg['dashboard_token']
    computer = os.environ.get('COMPUTERNAME', 'DESKTOP-SUB8JL6')
    log('epson_status (USB bidirecional) iniciando base=' + base)
    last = {}
    last_err_post = {}
    last_ink_at = {}    # name -> ts da ultima leitura de tinta
    last_ink = {}       # name -> dict de tinta (pra reenviar junto no status)
    # ROBUSTO (Bruno 07-23): rastreia o contador de labels em TODA passada. Detecta
    # impressao por "contador subiu" e FECHA o job quando o contador PARA de subir
    # por >=CTR_SETTLE_SEC. Nao depende mais de detectar a transicao imprimindo->ociosa
    # (que oscila/vem 'ER' e falhava). job_base = contador quando o job comecou.
    ctr_last = {}       # name -> ultimo valor do contador
    ctr_last_at = {}    # name -> ts em que o contador MUDOU pela ultima vez
    job_base = {}       # name -> contador no inicio do job em curso (None = sem job)
    job_started_at = {} # name -> ts do inicio do job
    CTR_SETTLE_SEC = 20 # contador parado por 20s = job terminou
    while True:
        try:
            paths = epson_usb_paths()
            for path in paths:
                try:
                    name = printer_name_for(path)
                    label, err, raw = query_state(path)
                except Exception as qe:
                    log('query erro: ' + str(qe))
                    continue
                if label is None and err is None:
                    label = 'ociosa'   # sem leitura de estado != erro; segue pro contador
                # TINTA: le a cada INK_POLL_SEC (5min) OU na 1a vez. Muda devagar.
                ink_now = None
                if time.time() - last_ink_at.get(name, 0) >= INK_POLL_SEC:
                    try:
                        ink_now = query_ink(path)
                        if ink_now:
                            last_ink[name] = ink_now
                            last_ink_at[name] = time.time()
                            ks = ink_now.get('ink') or {}
                            log('TINTA ' + name + ': ' + ', '.join(k + '=' + (v.get('label') or '?') for k, v in ks.items())
                                + (' | maint=' + (ink_now.get('maint_box') or {}).get('label', '?') if ink_now.get('maint_box') else '')
                                + (' | avisos=' + ','.join(ink_now.get('warnings') or []) if ink_now.get('warnings') else ''))
                    except Exception as ie:
                        log('tinta erro: ' + str(ie))
                key = (label or '') + '|' + (err or '')
                changed = last.get(name) != key
                now = time.time()

                # ── CONTADOR ROBUSTO: le em TODA passada ──────────────────────────
                labels_printed = None
                try:
                    c = query_counter(path)
                except Exception as ce:
                    c = None
                    log('contador erro: ' + str(ce))
                if c is not None:
                    prev = ctr_last.get(name)
                    if prev is None:
                        # 1a leitura: estabelece a linha de base ociosa
                        ctr_last[name] = c
                        ctr_last_at[name] = now
                    elif c > prev:
                        # contador SUBIU = imprimindo. Se nao ha job aberto, abre um.
                        if job_base.get(name) is None:
                            job_base[name] = prev
                            job_started_at[name] = now
                            log('CONTADOR ' + name + ': impressao iniciou (base ' + str(prev) + ')')
                        ctr_last[name] = c
                        ctr_last_at[name] = now
                        label = 'imprimindo'   # forca o estado pelo contador (mais confiavel)
                    else:
                        # contador PAROU (c == prev). Job aberto + parado ha CTR_SETTLE_SEC = terminou.
                        if job_base.get(name) is not None and (now - ctr_last_at.get(name, now)) >= CTR_SETTLE_SEC:
                            labels_printed = c - job_base[name]
                            log('CONTADOR ' + name + ': ' + str(job_base[name]) + ' -> ' + str(c)
                                + ' = ' + str(labels_printed) + ' labels (job fechado)')
                            job_base[name] = None
                            job_started_at[name] = None
                            label = 'ociosa'
                        elif job_base.get(name) is not None:
                            label = 'imprimindo'   # ainda no periodo de settle
                # ERRO tem PRIORIDADE sobre o contador (Bruno 07-24): se a impressora
                # reportou erro (SEA,E != NE), o estado e 'erro' — nem imprimindo nem
                # ociosa. Assim travamento/sem-papel/atolou aparece de verdade.
                if err:
                    label = 'erro'
                # recomputa key/changed com o label possivelmente ajustado pelo contador
                key = (label or '') + '|' + (err or '')
                changed = last.get(name) != key
                resend_err = (label == 'erro') and (time.time() - last_err_post.get(name, 0) >= 60)
                # manda quando: muda de estado, re-erro, tinta nova, OU um job fechou
                # (labels_printed setado) — este ultimo NAO pode depender de 'changed'.
                if changed or resend_err or ink_now or labels_printed is not None:
                    if changed:
                        log('FISICO ' + name + ': ' + str(label) + (' ERR=' + err if err else ''))
                    post_status(base, token, computer, name, label, err, raw,
                                ink=(ink_now or last_ink.get(name)), labels_printed=labels_printed)
                    last[name] = key
                    if label == 'erro':
                        last_err_post[name] = time.time()
                    elif name in last_err_post:
                        del last_err_post[name]
        except Exception as e:
            log('loop erro: ' + str(e))
        time.sleep(POLL_SEC)


def main():
    # guard de instancia unica (nao sai se falhar o mutex — melhor rodar que nao)
    try:
        mtx = single_instance()
        if mtx is None:
            return
    except Exception as e:
        log('mutex erro (segue): ' + str(e))
    # wrapper anti-crash: se run_loop() estourar por qualquer motivo (ate falha
    # nativa recuperavel), loga e reinicia em 5s — nunca deixa o processo morrer.
    while True:
        try:
            run_loop()
        except BaseException as e:
            log('run_loop CAIU (reinicia em 5s): ' + repr(e))
            time.sleep(5)


if __name__ == '__main__':
    main()
