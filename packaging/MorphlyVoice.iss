#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#ifndef StageDir
  #error StageDir must point to the prepared Morphly Voice directory.
#endif
#ifndef OutputDir
  #define OutputDir SourcePath + "output"
#endif

#define AppName "Morphly Voice"
#define AppPublisher "Morphly"
#define AppUrl "https://github.com/samuellucky2424-afk/morphly-voice-"

[Setup]
AppId={{03E3A91B-8F56-4D50-A2B5-938120D2D1E7}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
AppUpdatesURL={#AppUrl}
DefaultDirName={localappdata}\Programs\Morphly Voice
DefaultGroupName=Morphly Voice
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Morphly-Voice-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
DiskSpanning=no
WizardStyle=modern
SetupLogging=yes
CloseApplications=no
RestartApplications=no
SetupIconFile={#StageDir}\MorphlyVoice.ico
LicenseFile={#StageDir}\LICENSE
InfoBeforeFile={#StageDir}\BEATRICE-REDISTRIBUTION-NOTICE.txt
UninstallDisplayName=Morphly Voice
UninstallDisplayIcon={app}\MorphlyVoice.ico
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Morphly Voice Windows installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Excludes: "server\stored_setting.json,engines\beatrice-v2\settings\vc_conf.json,engines\beatrice-v2\model_dir\1\params.json"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\server\stored_setting.json"; DestDir: "{app}\server"; Flags: ignoreversion onlyifdoesntexist uninsneveruninstall
Source: "{#StageDir}\engines\beatrice-v2\settings\vc_conf.json"; DestDir: "{app}\engines\beatrice-v2\settings"; Flags: ignoreversion onlyifdoesntexist uninsneveruninstall
Source: "{#StageDir}\engines\beatrice-v2\model_dir\1\params.json"; DestDir: "{app}\engines\beatrice-v2\model_dir\1"; Flags: ignoreversion onlyifdoesntexist uninsneveruninstall

[Dirs]
Name: "{app}\runtime-logs"
Name: "{app}\runtime-state"
Name: "{app}\server\logs"
Name: "{app}\server\upload_dir"
Name: "{app}\server\tmp_dir"
Name: "{app}\engines\beatrice-v2\settings"
Name: "{app}\engines\beatrice-v2\logs"
Name: "{app}\engines\beatrice-v2\upload_dir"
Name: "{app}\engines\beatrice-v2\tmp_dir"

[Icons]
Name: "{autoprograms}\Morphly Voice"; Filename: "{app}\start_http.bat"; WorkingDir: "{app}"; IconFilename: "{app}\MorphlyVoice.ico"
Name: "{autodesktop}\Morphly Voice"; Filename: "{app}\start_http.bat"; WorkingDir: "{app}"; IconFilename: "{app}\MorphlyVoice.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Run]
Filename: "{app}\start_http.bat"; WorkingDir: "{app}"; Description: "Start Morphly Voice"; Flags: postinstall nowait skipifsilent shellexec

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime-logs"
Type: filesandordirs; Name: "{app}\runtime-state"
