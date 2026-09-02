' Sobe o watchdog + o socket listener em janelas OCULTAS, no logon do Bruno.
Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run """" & scriptDir & "run-watchdog.cmd""", 0, False
sh.Run """" & scriptDir & "run-listener.cmd""", 0, False
