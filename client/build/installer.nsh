!macro customInstall
  ; Остановить и удалить существующую службу
  nsExec::ExecToStack 'sc stop "Electron Update Service"'
  Sleep 2000
  nsExec::ExecToStack 'sc delete "Electron Update Service"'
  Sleep 1000

  ; Зарегистрировать и запустить службу
  nsExec::ExecToStack `sc create "Electron Update Service" binPath= "$\"$INSTDIR\ElectronUpdateService.exe$\"" start= auto DisplayName= "Electron Update Service"`
  nsExec::ExecToStack `sc description "Electron Update Service" "Обновление корпоративного приложения Electron"`
  nsExec::ExecToStack 'sc start "Electron Update Service"'

  ; Запустить приложение
  ExecShell "" "$INSTDIR\Electron.exe"
!macroend

!macro customUninstall
  nsExec::ExecToStack 'sc stop "Electron Update Service"'
  Sleep 2000
  nsExec::ExecToStack 'sc delete "Electron Update Service"'
!macroend
