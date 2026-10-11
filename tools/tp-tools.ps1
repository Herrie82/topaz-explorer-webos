# Helpers for working on the TouchPad over novacom. Dot-source this file:
#     . .\tools\tp-tools.ps1
$script:Nov = "C:\Program Files\Palm, Inc\novacom.exe"

# Run a shell script on the TouchPad. Going through a file avoids PowerShell's quoting problems.
function Invoke-Tp([string]$Script) {
    $f = Join-Path $env:TEMP "tp-cmd.sh"
    [IO.File]::WriteAllText($f, ($Script -replace "`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
    cmd /c "`"$script:Nov`" -d usb put file:///tmp/tp-cmd.sh < `"$f`"" | Out-Null
    & $script:Nov -d usb run file:///bin/sh /tmp/tp-cmd.sh 2>&1
}

# Copy a file from the TouchPad to this PC.
function Get-TpFile([string]$Remote, [string]$Local) {
    cmd /c "`"$script:Nov`" -d usb get file://$Remote > `"$Local`""
}

# Take a screenshot of the TouchPad. The image comes out in the panel's own orientation.
function Get-TpShot([string]$Out) {
    Invoke-Tp "luna-send -n 1 palm://com.palm.systemmanager/takeScreenShot '{`"file`":`"/media/internal/.fm-shot.png`"}' >/dev/null 2>&1" | Out-Null
    Get-TpFile "/media/internal/.fm-shot.png" $Out
}

# Close the app, start it once showing a folder, wait, print what the app and its
# service logged, and take a screenshot. One cold start: never send a second launch
# into an app that is still starting.
#     Show-FmFolder "/media/internal/DCIM" shot.png -View icons
function Show-FmFolder([string]$Path = "/media/internal", [string]$Shot, [string]$View = "", [int]$Seconds = 6, [string]$Show = "") {
    if ($Path -match '["\\]' -or $View -notmatch '^(|icons|details)$') { throw "Unusable path or view." }
    $params = '{"path":"' + $Path + '"' + $(if ($View) { ',"view":"' + $View + '"' }) + $(if ($Show) { ',"show":"' + $Show + '"' }) + '}'
    $launch = '{"id":"com.palm.stark.files","params":' + $params + '}'
    $env:JAVA_HOME = "G:\Java\jdk17"
    $env:Path = "G:\Java\jdk17\bin;G:\webOS\PalmSDK\Current\bin;" + $env:Path
    cmd /c "palm-launch.bat -d usb -c com.palm.stark.files 2>&1" | Out-Null
    $lines = @(
        'sleep 3',
        'wc -l < /var/log/messages > /tmp/fm-mark',
        "luna-send -n 1 palm://com.palm.applicationManager/launch '$launch' >/dev/null 2>&1",
        "sleep $Seconds",
        'tail -n +$(cat /tmp/fm-mark) /var/log/messages > /tmp/fm-new.log',
        'grep -E "\[files\]|\[fmfiles\]|Uncaught|stark.files.*[Ee]rror|kgsl" /tmp/fm-new.log | sed -e "s/^[^ ]* \[[0-9]*\] [^ ]* //" | cut -c1-300 | tail -n 20'
    )
    Invoke-Tp ($lines -join "`n")
    if ($Shot) { Get-TpShot $Shot }
}
