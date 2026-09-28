; Included by electron-builder's NSIS script (`nsis.include` in electron-builder.yml).
;
; Builds up to 0.9.0 shipped a copy of earlier builds inside resources\server\release, each
; nested in the last. An update first runs the installed version's uninstaller, which moves
; every file into %TEMP% before deleting it; the deepest of those paths is past MAX_PATH
; there, the move fails, and the whole update is rolled back (installer exit code 2).
;
; customInit runs in .onInit, before the old uninstaller, so the nest is gone by the time it
; looks. Nothing in it is used at runtime. `rd` with a \\?\ path is not bound by MAX_PATH,
; which matters on machines whose user name is longer than the one the paths just fit under.
!macro customInit
  ${if} ${FileExists} "$INSTDIR\resources\server\release\*.*"
    nsExec::Exec `"$SYSDIR\cmd.exe" /C rd /S /Q "\\?\$INSTDIR\resources\server\release"`
    Pop $0
  ${endif}
!macroend
