' Sobe watchdog + socket listener + agendador em janelas OCULTAS, no logon do Bruno.
' Tudo o que precisa rodar sozinho (inclusive apos reboot) entra aqui.
Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run """" & scriptDir & "run-watchdog.cmd""", 0, False
sh.Run """" & scriptDir & "run-listener.cmd""", 0, False
sh.Run """" & scriptDir & "run-scheduler.cmd""", 0, False
