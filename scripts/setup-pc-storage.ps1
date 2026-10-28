# One-time setup for PC leaderboard storage. Run from the BUZZER GAME folder:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-pc-storage.ps1
# 1. Gives the Vercel project the password (PC_SHARED_SECRET) it needs to reach this PC.
# 2. Redeploys the game so it uses that password.
# 3. Starts scripts\pc-storage.mjs now and at every Windows sign-in, hidden.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
Set-Location $dir

if (-not (Test-Path "$dir\.env.pc")) {
  throw ".env.pc not found. Run 'node scripts\pc-storage.mjs' once to create it, then stop it with Ctrl+C."
}
$secret = ((Get-Content "$dir\.env.pc" | Where-Object { $_ -like 'PC_SHARED_SECRET=*' }) -replace '^PC_SHARED_SECRET=', '').Trim()

Write-Host 'Saving PC_SHARED_SECRET to the Vercel project...'
npx --yes vercel env rm PC_SHARED_SECRET production --yes 2>$null | Out-Null
$secret | npx --yes vercel env add PC_SHARED_SECRET production --sensitive
Write-Host 'Redeploying the game...'
npx --yes vercel deploy --prod --yes | Out-Null

Write-Host 'Setting up automatic start at sign-in...'
Unregister-ScheduledTask -TaskName 'Buzzer Game Score Backup' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Buzzer Game PC Storage' -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless `"C:\Program Files\nodejs\node.exe`" `"$dir\scripts\pc-storage.mjs`"" -WorkingDirectory $dir
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Buzzer Game PC Storage' -Description "Main leaderboard storage for the Blind 5 Seconds game (scores in $dir\backups)" -Action $action -Trigger $logon -Settings $settings | Out-Null
Start-ScheduledTask -TaskName 'Buzzer Game PC Storage'

Write-Host 'Waiting for the tunnel to connect...'
Start-Sleep -Seconds 30
Get-Content "$dir\backups\pc-storage.log" -Tail 3
Write-Host "`nDone. Open the leaderboard on https://buzzer-game-iota.vercel.app - it should say 'Live - All players'."
