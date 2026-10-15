# To do

## Network folders (FTP), 2026-10-15

Browsing: type an ftp:// or ftps:// address through the globe button in the
path bar; the name and password are asked for when the server wants them and
the address did not carry them. Copy brings things down from a site and takes
them up to one (Cut = move: the source goes only when every part arrived).
Delete, rename and New Folder work on the site. Everything runs through the
system's curl (7.88.1 on webOS CE), one transfer at a time, so a copy is as
fast as one curl per file (~50 small files a minute over the LAN, roughly).

Not yet: SFTP and SMB. The system curl has no sftp (and the curl-tls13
package's libcurl does not either), so SFTP waits on building libssh2 + curl
with the PDK like 7za. SMB needs a curl built with libsmb or a small
libsmbclient tool; the kernel's own CIFS mount cannot talk to modern servers
(Samba 4 rejects its SMB1). Also not yet: copying from one site folder to
another (go through My TouchPad), opening a file straight from a site (copy
it first), searching below a site folder, and compressing on a site.

## Checked on the TouchPad (2026-10-10)

By screenshot: details list, icons view with photo thumbnails, folder tree, path bar, a system
folder shown read-only. Through the service from a shell: new folder, rename (and a refused name),
copy of a deep folder (checksums match the source), Replace / Skip / Keep Both, a copy beside the
original, move, a move that merges folders, a move across disks, delete, details, search, the
refusals outside the storage, opening and closing the system disk, and second-by-second progress
on a copy and a delete of 1,891 files; making zip, 7z and tar archives and extracting zip, 7z,
tar.gz, RAR3 and RAR5 (checksums match), password-protected zip and 7z; reading a text file and
saving it back with its line endings kept. By screenshot: the text editor showing a file. The
picture viewer and opening a PDF in Adobe Reader were confirmed by the user.

## Not yet tried by hand

Everything that takes a finger: hold to select, the selection bar, the dialogs (name, delete,
already-here, progress and its Cancel, details), Paste, the sort menu, the app menu, portrait;
typing and saving in the text editor (and where the cursor ends up when the keyboard is showing);
the Extract menu, the More menu and Compress, the password prompt.

## Known gaps

- The tree does not scroll to the folder being shown; "System" sits below all of My TouchPad's
  folders unless My TouchPad is closed.
- No "Open with": a file opens in whichever app the system picks. Pictures, text and archives
  are handled by Topaz Explorer itself.
- The text editor opens files up to 300 KB, has no find, and no undo beyond the keyboard's own.
- An archive cannot be looked into without extracting it, and .tar.gz cannot be made (zip, 7z and
  tar can).
- The bar under Compress stops a little short of the end (folders are not counted as they go in).
- The picture viewer has no pinch zoom and shows nothing while a photo loads (2-3 seconds).
- A link to a folder is left out of a copy and counted as "could not be copied".
- Small files copy at about 50 a second.
- Nothing shows a running job once the app is in the background (no dashboard notification).
- No drag and drop.
- A job's progress bar counts items, not bytes, for moves.
- One window, one folder at a time: no tabs or side-by-side panes.
- The icon is a first drawing.
