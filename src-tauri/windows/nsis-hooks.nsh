; Keep Board NSIS hooks
; Keep the "Run app after install" option unchecked by default.
!define MUI_FINISHPAGE_RUN_NOTCHECKED

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
