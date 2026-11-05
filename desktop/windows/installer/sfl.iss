; Per-user installer for the Windows local client. Built by
; `node scripts/package-local-client.mjs windows-x64 --installer`, which stages
; the bundled-Node package and passes its location and the version below.
; No administrator rights: installs into %LOCALAPPDATA%\Programs.

#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z
#endif
#ifndef FileVersion
  #error Pass /DFileVersion=x.y.z.0
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<staged bundled-Node package>
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

#define AppName "Scientific Figure Library"
#define AppUrl "https://github.com/xuzhougeng/ScientificFigureLibrary"

[Setup]
; Never change AppId: upgrades and uninstall find earlier installs by it.
AppId={{7D5AAE52-BF12-4BD2-9042-586BC36DE9F1}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#FileVersion}
VersionInfoProductVersion={#AppVersion}
DefaultDirName={userpf}\ScientificFigureLibrary
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; Setup and uninstall wait for a running SFL.exe (see desktop/windows/shell).
AppMutex=Local\ScientificFigureLibrary.Desktop
CloseApplications=yes
RestartApplications=no
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
ShowLanguageDialog=auto
WizardStyle=modern
SetupIconFile=sfl.ico
UninstallDisplayIcon={app}\SFL.exe
UninstallDisplayName={#AppName}
OutputDir={#OutputDir}
OutputBaseFilename=ScientificFigureLibrary-{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes

[Languages]
Name: "zh"; MessagesFile: "ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Remove the previous version's top-level entries so stale files never mix
; with a new build. Generated from the staged package; see the build script.
#include "payload.iss"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\SFL.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\SFL.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\SFL.exe"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: dirifempty; Name: "{app}"
