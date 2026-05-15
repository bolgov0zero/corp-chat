!macro customInstall
  ; Создать папку и скрипт обновления
  CreateDirectory "$COMMONAPPDATA\Electron"

  FileOpen $0 "$COMMONAPPDATA\Electron\run_update.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "set /p INSTALLER=<$\"%ProgramData%\Electron\update_path.txt$\"$\r$\n"
  FileWrite $0 "if exist $\"%INSTALLER%$\" $\"%INSTALLER%$\" /S$\r$\n"
  FileClose $0

  ; Удалить старое задание если есть
  nsExec::ExecToStack 'schtasks /delete /tn "Electron Update Service" /f'

  ; Создать задание с правами SYSTEM
  nsExec::ExecToStack 'schtasks /create /tn "Electron Update Service" /tr "\"$COMMONAPPDATA\Electron\run_update.cmd\"" /sc ONCE /sd 01/01/2099 /st 00:00 /ru SYSTEM /f'

  ; Запустить приложение
  ExecShell "" "$INSTDIR\Electron.exe"
!macroend

!macro customUninstall
  nsExec::ExecToStack 'schtasks /delete /tn "Electron Update Service" /f'
  Delete "$COMMONAPPDATA\Electron\run_update.cmd"
!macroend
