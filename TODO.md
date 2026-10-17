# To do

## Network folders (FTP, SFTP, SMB) and sharing, 2026-10-17

Type a folder or an address in the path bar (tap the globe or the path's empty
end): ftp://, ftps://, sftp://, smb://, or \server\share. The name and
password are asked for when the server wants them; an SFTP server's key
fingerprint is shown to be trusted the first time and refused if it changes
(kept in /var/preferences/com.palm.stark.files/known_hosts.json). Keys in
/media/internal/.ssh (id_ed25519, id_ecdsa, id_rsa) are tried before the
password. SFTP opens in the server's home folder; an SMB server's top lists its
shared folders. The bottom bar is green on a network drive.

FTP runs through the system's curl. SFTP and SMB 2/3 run through bin/topaz-net
(native/build-net.sh: libssh2 + OpenSSL 1.1.1w, libsmb2 6.0.0), one per
connection kept open, plus one per job. Checked on the TouchPad against the
homelab server: SFTP listing, upload of a folder tree, Keep Both naming, move
down (checksums match), rename, recursive delete, host key trust; SMB share
list, listing, upload, move down (checksums match), delete, names with % and
non-ASCII letters, a refused guest asking for a name. A 3 MB file went up
and came back down over SFTP in about 2 seconds over Wi-Fi.

Favorites: "Add to Favorites" in the app menu keeps the folder shown (local or
on a site, with the site's sign-in) at the top of the folder tree.

Sharing: "Share Over FTP" in the app menu serves /media/internal (service/ftpd.js,
its own process, so it outlives the app). One name and password, read-only if
chosen, port 2121 and passive ports 50100-50119 let through the firewall while
it runs; it keeps the TouchPad awake while on. Checked from Windows with curl:
listing, MLSD, uploads and downloads with matching checksums (~3 MB/s), resume,
rename, folders, a wrong password refused, `..` cannot leave the storage.

Through the TouchPad (a staging folder in /media/internal/.topaz-explorer,
emptied after): copying and moving between two sites, copying within one
site (a move within one site is a rename), compressing and extracting on a
site. Tapping a file on a site brings a copy into .topaz-explorer/cache (kept
two days, reused when the size matches) and opens it: pictures in the viewer
(each brought down as it is shown), text in the editor (saving sends it back
up), packages to Preware, anything else to its app. Search Subfolders works on
a site (2,000 folders or a minute at most). Hold a favorite to rename or
remove it. All checked through the service on the TouchPad on 2026-10-17;
opening a text file from SFTP was checked by the user.

Fixed 2026-10-17: the FTP server and topaz-net kept the file service's
connections to the system message hub, so after the service went to sleep
the hub still saw it and the app's calls hung. Both now close what they
inherit. An SMB server that is not there now fails in seconds, not 40.

Not yet: active-mode FTP from a client behind its own firewall did not connect
(passive does); SFTP and SMB on LuneOS (topaz-net is built for legacy webOS);
anything staged needs room for it on the storage, and FAT's 4 GB limit
applies to each file going through.

## Google Drive, 2026-10-17

A "Google Drive" account template (service/account, put in place by the
service on its first start; DOCUMENTS capability, like HP's Dropbox one) whose
sign-in page is the app itself: Open Atlas, then Connect (driveCheck). The
service reads Atlas's google.com cookies from /var/atlas252/webkit-data/
cookies.db with sqlite3 at each open, takes the API key from the Drive page,
and uses clients6.google.com/drive/v2internal with a SAPISIDHASH header;
downloads come from drive.usercontent.google.com, Google's own documents are
exported. The public v3 API refuses cookies. Paths are made from names (a
repeated name gets a number); ids are kept as folders are listed.

Checked on the TouchPad through the service: sign-in check, listing, new
folder, upload (700 KB, checksums match on the way back), download, rename,
move between folders (no download), replacing a file's contents, delete to
trash. The account was added in Accounts by the user and Drive showed in the
tree.

Not yet: Shared with me and shared drives; more than one Google account
(Atlas's first one is used); progress within a single Drive transfer;
exporting a Google document as anything but its Office kind. Unofficial API:
expect to adjust it when Google changes the web client.

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
