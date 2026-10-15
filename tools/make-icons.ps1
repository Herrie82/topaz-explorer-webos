# Draws the app's images into app\images. Run it again after changing a drawing.
#     powershell -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path (Split-Path $PSScriptRoot -Parent) "app\images"
New-Item -ItemType Directory -Force $out | Out-Null

function New-Canvas([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    return @{ Bmp = $bmp; G = $g }
}

function Save-Canvas($c, [string]$name) {
    $c.G.Dispose()
    $c.Bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $c.Bmp.Dispose()
}

function Rgb([int]$r, [int]$g, [int]$b, [int]$a = 255) {
    return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
}

# A rectangle with rounded corners, as a path.
function Round-Rect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# A manila folder filling a square of side $s at ($x, $y).
function Draw-Folder($g, [single]$x, [single]$y, [single]$s) {
    $u = $s / 64
    # The back, with its tab.
    $back = New-Object System.Drawing.Drawing2D.GraphicsPath
    $back.AddArc($x + 4 * $u, $y + 10 * $u, 6 * $u, 6 * $u, 180, 90)
    $back.AddLine($x + 7 * $u, $y + 10 * $u, $x + 24 * $u, $y + 10 * $u)
    $back.AddLine($x + 24 * $u, $y + 10 * $u, $x + 30 * $u, $y + 17 * $u)
    $back.AddLine($x + 30 * $u, $y + 17 * $u, $x + 57 * $u, $y + 17 * $u)
    $back.AddArc($x + 54 * $u, $y + 17 * $u, 6 * $u, 6 * $u, 270, 90)
    $back.AddLine($x + 60 * $u, $y + 20 * $u, $x + 60 * $u, $y + 52 * $u)
    $back.AddLine($x + 60 * $u, $y + 52 * $u, $x + 4 * $u, $y + 52 * $u)
    $back.CloseFigure()
    $b1 = New-Object System.Drawing.SolidBrush (Rgb 214 158 46)
    $g.FillPath($b1, $back)
    # The front.
    $front = Round-Rect ($x + 4 * $u) ($y + 22 * $u) (56 * $u) (33 * $u) (3 * $u)
    $rect = New-Object System.Drawing.RectangleF ($x + 4 * $u), ($y + 22 * $u), (56 * $u), (33 * $u)
    $b2 = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, (Rgb 255 221 120), (Rgb 245 190 70), 90
    $g.FillPath($b2, $front)
    $pen = New-Object System.Drawing.Pen (Rgb 190 136 34), ([Math]::Max(1, $u))
    $g.DrawPath($pen, $front)
    $hi = New-Object System.Drawing.Pen (Rgb 255 240 190), ([Math]::Max(1, $u))
    $g.DrawLine($hi, $x + 7 * $u, $y + 23.5 * $u, $x + 57 * $u, $y + 23.5 * $u)
}

# A sheet of paper with a turned corner.
function Draw-Page($g, [single]$x, [single]$y, [single]$s) {
    $u = $s / 64
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddLine($x + 13 * $u, $y + 5 * $u, $x + 39 * $u, $y + 5 * $u)
    $p.AddLine($x + 39 * $u, $y + 5 * $u, $x + 51 * $u, $y + 17 * $u)
    $p.AddLine($x + 51 * $u, $y + 17 * $u, $x + 51 * $u, $y + 59 * $u)
    $p.AddLine($x + 51 * $u, $y + 59 * $u, $x + 13 * $u, $y + 59 * $u)
    $p.CloseFigure()
    $rect = New-Object System.Drawing.RectangleF ($x + 13 * $u), ($y + 5 * $u), (38 * $u), (54 * $u)
    $b = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, (Rgb 255 255 255), (Rgb 236 238 241), 90
    $g.FillPath($b, $p)
    $pen = New-Object System.Drawing.Pen (Rgb 150 156 164), ([Math]::Max(1, $u))
    $g.DrawPath($pen, $p)
    $fold = New-Object System.Drawing.Drawing2D.GraphicsPath
    $fold.AddLine($x + 39 * $u, $y + 5 * $u, $x + 39 * $u, $y + 17 * $u)
    $fold.AddLine($x + 39 * $u, $y + 17 * $u, $x + 51 * $u, $y + 17 * $u)
    $fold.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush (Rgb 208 213 220)), $fold)
    $g.DrawPath($pen, $fold)
}

# folder.png, file.png
$c = New-Canvas 64 64; Draw-Folder $c.G 0 0 64; Save-Canvas $c "folder.png"
$c = New-Canvas 64 64; Draw-Page $c.G 0 0 64; Save-Canvas $c "file.png"

# device.png: the tablet, for the top of the folder tree.
$c = New-Canvas 48 48
$body = Round-Rect 5 9 38 30 4
$c.G.FillPath((New-Object System.Drawing.SolidBrush (Rgb 40 44 50)), $body)
$c.G.FillRectangle((New-Object System.Drawing.SolidBrush (Rgb 92 150 214)), 9, 13, 30, 22)
Save-Canvas $c "device.png"

# system.png: a disk drive, for the whole system in the folder tree.
$c = New-Canvas 48 48
$case = Round-Rect 5 14 38 20 4
$c.G.FillPath((New-Object System.Drawing.SolidBrush (Rgb 120 128 138)), $case)
$c.G.DrawPath((New-Object System.Drawing.Pen (Rgb 70 76 84), 2), $case)
$c.G.FillEllipse((New-Object System.Drawing.SolidBrush (Rgb 120 220 120)), 33, 21, 6, 6)
$c.G.DrawLine((New-Object System.Drawing.Pen (Rgb 70 76 84), 2), 10, 24, 26, 24)
Save-Canvas $c "system.png"

# back.png, forward.png, up.png: white arrows for the dark bar.
function Draw-Arrow([string]$name, [single[]]$pts) {
    $c = New-Canvas 24 24
    $pen = New-Object System.Drawing.Pen (Rgb 255 255 255), 3
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    for ($i = 0; $i -lt $pts.Length; $i += 4) {
        $c.G.DrawLine($pen, $pts[$i], $pts[$i + 1], $pts[$i + 2], $pts[$i + 3])
    }
    Save-Canvas $c $name
}
Draw-Arrow "back.png" @(19, 12, 5, 12, 5, 12, 11, 6, 5, 12, 11, 18)
Draw-Arrow "forward.png" @(5, 12, 19, 12, 19, 12, 13, 6, 19, 12, 13, 18)
Draw-Arrow "up.png" @(12, 19, 12, 5, 12, 5, 6, 11, 12, 5, 18, 11)

# net.png: a globe, for typing a site address.
$c = New-Canvas 24 24
$pen = New-Object System.Drawing.Pen (Rgb 255 255 255), 1.6
$c.G.DrawEllipse($pen, 3.5, 3.5, 17, 17)
$c.G.DrawEllipse($pen, 8.5, 3.5, 7, 17)
$c.G.DrawLine($pen, 4.5, 12, 19.5, 12)
Save-Canvas $c "net.png"

# check-off.png, check-on.png: the box beside each row while selecting.
$c = New-Canvas 22 22
$box = Round-Rect 1.5 1.5 19 19 3
$c.G.FillPath((New-Object System.Drawing.SolidBrush (Rgb 255 255 255)), $box)
$c.G.DrawPath((New-Object System.Drawing.Pen (Rgb 150 156 164), 1.5), $box)
Save-Canvas $c "check-off.png"
$c = New-Canvas 22 22
$box = Round-Rect 1.5 1.5 19 19 3
$c.G.FillPath((New-Object System.Drawing.SolidBrush (Rgb 42 110 190)), $box)
$tick = New-Object System.Drawing.Pen (Rgb 255 255 255), 2.6
$tick.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$tick.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$tick.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$c.G.DrawLines($tick, [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 5.5, 11.5),
    (New-Object System.Drawing.PointF 9.5, 15.5),
    (New-Object System.Drawing.PointF 16.5, 6.5)))
Save-Canvas $c "check-on.png"

# The app's icon: a folder over a faint white disc with a soft shadow.
function Draw-AppIcon([int]$size, [string]$name) {
    $c = New-Canvas $size $size
    $u = $size / 64
    for ($i = 4; $i -ge 1; $i--) {
        $c.G.FillEllipse((New-Object System.Drawing.SolidBrush (Rgb 0 0 0 10)),
            (3 - $i * 0.5) * $u, (5 - $i * 0.2) * $u, (58 + $i) * $u, (58 + $i) * $u)
    }
    $c.G.FillEllipse((New-Object System.Drawing.SolidBrush (Rgb 255 255 255 110)), 3 * $u, 3 * $u, 58 * $u, 58 * $u)
    Draw-Folder $c.G (8 * $u) (7 * $u) (48 * $u)
    Save-Canvas $c $name
}
Draw-AppIcon 64 "icon.png"
Draw-AppIcon 256 "icon-256x256.png"

Get-ChildItem $out | Select-Object Name, Length
