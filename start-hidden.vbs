' start-hidden.vbs — starts marks with no console window. Put a shortcut to this file in shell:startup.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd /c cd /d """ & dir & """ && node server.js", 0
