!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro quitIfFreshellIsRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    SetErrorLevel 1
    ${if} ${Silent}
      DetailPrint "${PRODUCT_NAME} is running. Quit ${PRODUCT_NAME} before running this installer."
    ${else}
      MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "${PRODUCT_NAME} is running. Quit ${PRODUCT_NAME} before running this installer."
    ${endIf}
    ${nsProcess::Unload}
    Quit
  ${endIf}
  ${nsProcess::Unload}
!macroend

!macro customInit
  !insertmacro quitIfFreshellIsRunning
!macroend

!macro customCheckAppRunning
  !insertmacro quitIfFreshellIsRunning
!macroend

!macro customInstall
  ${StdUtils.GetParameter} $0 "FRESHELL_REMOTE_URL" ""
  ${StdUtils.GetParameter} $1 "FRESHELL_TOKEN" ""

  ${if} $0 != ""
  ${andIf} $1 != ""
    CreateDirectory "$PROFILE\.freshell"
    FileOpen $2 "$PROFILE\.freshell\desktop.json" w
    FileWrite $2 "{$\r$\n"
    FileWrite $2 "  $\"serverMode$\": $\"remote$\",$\r$\n"
    FileWrite $2 "  $\"port$\": 3001,$\r$\n"
    FileWrite $2 "  $\"remoteUrl$\": $\"$0$\",$\r$\n"
    FileWrite $2 "  $\"remoteToken$\": $\"$1$\",$\r$\n"
    FileWrite $2 "  $\"globalHotkey$\": $\"CommandOrControl+`$\",$\r$\n"
    FileWrite $2 "  $\"startOnLogin$\": false,$\r$\n"
    FileWrite $2 "  $\"minimizeToTray$\": true,$\r$\n"
    FileWrite $2 "  $\"setupCompleted$\": true$\r$\n"
    FileWrite $2 "}$\r$\n"
    FileClose $2
  ${endIf}
!macroend
