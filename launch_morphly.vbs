Option Explicit

Dim shell, fso, appRoot, electronExe, desktopApp, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appRoot = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = fso.BuildPath(appRoot, "electron-runtime\Morphly Voice.exe")
desktopApp = fso.BuildPath(appRoot, "electron-runtime\resources\app.asar")

If fso.FileExists(electronExe) And fso.FileExists(desktopApp) Then
    command = """" & electronExe & """"
    shell.Run command, 1, False
Else
    MsgBox "The Morphly Voice desktop runtime is missing." & vbCrLf & _
        "Please repair or reinstall Morphly Voice.", _
        vbExclamation, "Morphly Voice"
End If
