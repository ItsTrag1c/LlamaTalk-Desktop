; LlamaTalk Desktop — Custom NSIS installer hooks
; Included by Tauri's generated installer script.
; ${PRODUCTNAME}, ${VERSION}, $INSTDIR, $EXEPATH, $EXEFILE are all available here.

; Called at the end of the Install section (after files written, WriteUninstaller, and registry).
!macro customInstall
  ; Copy the running installer into Program Files with its original versioned name
  CopyFiles /SILENT "$EXEPATH" "$INSTDIR\$EXEFILE"

  ; Rename Tauri's generic "uninstall.exe" to a versioned name matching the installer scheme
  Rename "$INSTDIR\uninstall.exe" "$INSTDIR\LlamaTalk Desktop_${VERSION}_uninstall.exe"

  ; Update Add/Remove Programs UninstallString to point to the renamed uninstaller
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" \
    "UninstallString" '"$INSTDIR\LlamaTalk Desktop_${VERSION}_uninstall.exe"'

  ; Remove old versioned setup and uninstall files from previous version installs
  FileOpen $R0 "$TEMP\lt-desktop-ver-cleanup.ps1" w
  FileWrite $R0 "$$d = '$INSTDIR'$\r$\n"
  FileWrite $R0 "Get-ChildItem -LiteralPath $$d -Filter 'LlamaTalk Desktop_*_setup.exe' | Where-Object { $$_.Name -ne '$EXEFILE' } | Remove-Item -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R0 "Get-ChildItem -LiteralPath $$d -Filter 'LlamaTalk Desktop_*_uninstall.exe' | Where-Object { $$_.Name -ne 'LlamaTalk Desktop_${VERSION}_uninstall.exe' } | Remove-Item -Force -ErrorAction SilentlyContinue$\r$\n"
  FileClose $R0
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\lt-desktop-ver-cleanup.ps1"'
  Delete "$TEMP\lt-desktop-ver-cleanup.ps1"
!macroend

; Called at the start of the Uninstall section.
; Tauri will also try to delete "uninstall.exe" — that's a silent no-op since we renamed it.
!macro customUnInstall
  FileOpen $R0 "$TEMP\lt-desktop-uninstall-cleanup.ps1" w
  FileWrite $R0 "$$d = '$INSTDIR'$\r$\n"
  FileWrite $R0 "Get-ChildItem -LiteralPath $$d -Filter 'LlamaTalk Desktop_*_setup.exe' | Remove-Item -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R0 "Get-ChildItem -LiteralPath $$d -Filter 'LlamaTalk Desktop_*_uninstall.exe' | Remove-Item -Force -ErrorAction SilentlyContinue$\r$\n"
  FileClose $R0
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\lt-desktop-uninstall-cleanup.ps1"'
  Delete "$TEMP\lt-desktop-uninstall-cleanup.ps1"
!macroend
