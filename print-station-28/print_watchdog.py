# -*- coding: utf-8 -*-
r"""
HealthFare — Watchdog da estacao de impressao (.28). Bruno 07-24.

Vigia os processos criticos da impressao e REVIVE quem cair, alem de AVISAR o
backend (que posta no #admin-orin) quando precisa reviver. Resolve a raiz do
"printmon fora = jobs somem sem alerta" que ja mordeu 2x (reboot + reinicio).

Roda como tarefa SYSTEM/BootTrigger (nao morre com o SSH). Checa a cada 60s.
printlock NAO entra aqui (tem GUI, vive na sessao interativa via PrintSessionApps).
"""
import time
import json
import subprocess
import urllib.request

CFG_PATH = r'C:\ProgramData\MediaServer\print\print.config.json'
LOG_PATH = r'C:\ProgramData\MediaServer\logs\print_watchdog.log'
PY = r'C:\Python314\pythonw.exe'
DIR = r'C:\ProgramData\MediaServer\print'
CHECK_SEC = 60

# processos Python que o watchdog vigia e revive (script -> nome amigavel).
# printprogress e printlock NAO entram: printprogress.ps1 e gerenciado pela tarefa
# PrintProgress do Windows; printlock tem GUI (sessao interativa, PrintSessionApps).
WATCHED = {
    'printmon.py': 'captura de impressao (printmon)',
    'epson_status.py': 'status fisico da EPSON (epson_status)',
}


def log(msg):
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S') + '  ' + msg + '\n')
    except Exception:
        pass


def load_cfg():
    with open(CFG_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def running_scripts():
    """Retorna o set de scripts .py rodando agora (via WMIC CommandLine)."""
    try:
        out = subprocess.run(
            ['wmic', 'process', 'where', "name='pythonw.exe'", 'get', 'CommandLine', '/format:list'],
            capture_output=True, text=True, timeout=25).stdout
    except Exception as e:
        log('wmic falhou: ' + str(e))
        return None   # None = nao sei (nao reinicia as cegas)
    found = set()
    for scr in WATCHED:
        if scr in out:
            found.add(scr)
    return found


def start(script):
    """Sobe um script via 'start' desanexado (sobrevive)."""
    try:
        subprocess.Popen([PY, DIR + '\\' + script], cwd=DIR,
                         creationflags=0x00000008)  # DETACHED_PROCESS
        return True
    except Exception as e:
        log('falha ao subir ' + script + ': ' + str(e))
        return False


def notify_backend(base, token, script, friendly):
    """Avisa o backend que reviveu um processo (backend posta no #admin-orin)."""
    try:
        url = base.rstrip('/') + '/api/print-watchdog'
        body = json.dumps({'event': 'revived', 'script': script, 'friendly': friendly,
                           'computer': 'Printer-PC'}).encode('utf-8')
        req = urllib.request.Request(url, data=body, method='POST',
                                    headers={'X-Print-Token': token, 'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log('notify falhou: ' + str(e))


def main():
    cfg = load_cfg()
    base = cfg['dashboard_url'].replace('/api/print-event', '')
    token = cfg['dashboard_token']
    log('watchdog iniciado (checa a cada %ds)' % CHECK_SEC)
    # da uns segundos pro boot subir os processos antes de vigiar
    time.sleep(30)
    while True:
        try:
            found = running_scripts()
            if found is not None:
                for script, friendly in WATCHED.items():
                    if script not in found:
                        log('CAIU: ' + script + ' -> revivendo')
                        if start(script):
                            time.sleep(3)
                            log('revivido: ' + script)
                            notify_backend(base, token, script, friendly)
        except Exception as e:
            log('loop erro: ' + str(e))
        time.sleep(CHECK_SEC)


if __name__ == '__main__':
    main()
