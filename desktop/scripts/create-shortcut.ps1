$wsh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'SovereignBot.lnk'
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'E:\Eternal\Auto_Empire\projects\SovereignBot-luna-attention\desktop\node_modules\electron\dist\electron.exe'
$shortcut.Arguments = '.'
$shortcut.WorkingDirectory = 'E:\Eternal\Auto_Empire\projects\SovereignBot-luna-attention\desktop'
$shortcut.IconLocation = 'E:\Eternal\Auto_Empire\projects\SovereignBot-luna-attention\desktop\resources\icon.ico,0'
$shortcut.Description = 'SovereignBot - Your AI Coworker OS'
$shortcut.Save()
Write-Host "Created shortcut successfully at: $shortcutPath"
