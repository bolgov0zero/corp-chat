!macro customInstall
  ; Читаем путь к ProgramData из переменной окружения
  ReadEnvStr $R0 PROGRAMDATA

  ; Создаём папку и скрипт обновления
  CreateDirectory "$R0\Electron"

  FileOpen $0 "$R0\Electron\run_update.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "set /p INSTALLER=<$\"%ProgramData%\Electron\update_path.txt$\"$\r$\n"
  FileWrite $0 "if exist $\"%INSTALLER%$\" $\"%INSTALLER%$\" /S$\r$\n"
  FileClose $0

  ; Удалить старое задание если есть
  nsExec::ExecToStack 'schtasks /delete /tn "Electron Update Service" /f'

  ; Собрать команду создания задания со значением $R0
  StrCpy $1 'schtasks /create /tn "Electron Update Service" /tr '
  StrCpy $1 "$1$\"$R0\Electron\run_update.cmd$\""
  StrCpy $1 "$1 /sc ONCE /sd 01/01/2099 /st 00:00 /ru SYSTEM /f"
  nsExec::ExecToStack $1

  ; Запустить приложение
  ExecShell "" "$INSTDIR\Electron.exe"
!macroend

!macro customUninstall
  nsExec::ExecToStack 'schtasks /delete /tn "Electron Update Service" /f'
!macroend
