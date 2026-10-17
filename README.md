# Topaz Explorer

A file manager for the HP TouchPad (webOS 3.0.5 and webOS Community Edition) that works like a
desktop one: a folder tree on the left, the folder's contents on the right, and back, forward, up
and a tappable path across the top. It reaches the whole system, not only the USB drive.

"Topaz" was HP's own name for the TouchPad while it was being made.

## What it can do

**Getting around**
- A folder tree beside a details list (name, date, type, size) or a grid of icons.
- Back, forward and up, and a path bar whose every part can be tapped.
- Sort by name, date, type or size; tap a column heading to sort by it.
- Type in the search box to narrow the folder; "Search Subfolders" looks below it too.
- Show or hide hidden files.

**Working with files**
- Tap to open, hold to select, then tap to add to the selection.
- Copy, cut, paste, rename, delete, new folder, and details (size, what a folder holds).
- A progress dialog with Cancel for anything that takes time, and a choice of Replace, Skip These
  or Keep Both when names collide. A long job carries on if the app is closed.

**Opening things**
- Files open in the app registered for them (music, video, PDFs, documents and so on).
- Pictures open in a viewer of its own, with swipes to the folder's other pictures. webOS has no
  app that takes a picture file to show.
- Text and configuration files open in an editor of its own. Line endings and older character
  sets are written back as they were found.
- Photos show as thumbnails in the icons view.

**Archives**
- Tap an archive to extract it: 7z, zip, rar (including RAR5), tar, gz, bz2, xz, cab, iso, deb,
  rpm and more. Password-protected archives ask for the password.
- Select things and choose More, then Compress, to make a .zip, .7z or .tar.

**The whole system**
- "System" in the folder tree is the TouchPad's root folder. Everything outside the USB drive is
  read-only to begin with; things can be copied out of it.
- "Allow System Changes" in the app menu lifts that for the session, after a warning. The bottom
  bar turns red wherever a change would touch system files. A few things stay off limits even
  then: the live folders `/proc`, `/sys` and `/dev`, and removing or renaming a top-level folder
  such as `/usr` whole.

**Network folders**
- Type a folder, or an `ftp://`, `ftps://`, `sftp://` or `smb://` address (or
  `\server\share`), in the path bar: tap the globe, or the empty end of the
  path. Copy, Cut, Paste, Delete, Rename and New Folder work between a server
  and the TouchPad.
- SFTP asks you to trust a server's key the first time and warns if it
  changes; keys in `/media/internal/.ssh` are used when there are any. SMB
  speaks SMB 2 and 3 and lists a server's shared folders.
- "Add to Favorites" in the app menu puts the folder (or site, with its
  sign-in) at the top of the folder tree.

**Google Drive**
- Add a "Google Drive" account in Accounts (Add an Account). It uses the Google
  sign-in in the Atlas browser: sign in at drive.google.com in Atlas, then tap
  Connect. Google Drive then shows in the folder tree, and works like the other
  network folders. Deleting puts things in Drive's trash. Google Docs, Sheets,
  Slides and Drawings come down as .docx, .xlsx, .pptx and .pdf.
- It talks to Drive the way drive.google.com does, with Atlas's cookies, which
  are read on the TouchPad each time Drive is opened and never sent anywhere
  but Google. Signing out of Google in Atlas signs Drive out too. As it is not
  Google's published API, a change on Google's side can break it.

**Sharing**
- "Share Over FTP" in the app menu lets other computers open the TouchPad's
  storage with a name and password, optionally read-only. It keeps going when
  the app is closed, and keeps the TouchPad awake, until stopped.

## Installing

Install the `.ipk` from the [releases page](../../releases) with WebOS Quick Install, Preware
("Install Package"), or `palm-install` from the SDK.

It has been used on a TouchPad running webOS Community Edition 3.1.0. It is a first release:
see [TODO.md](TODO.md) for what has been checked and what is known to be missing.

## On LuneOS

The same app runs on LuneOS (tried on a mindphone and a Samsung SM-T520,
armv7, and a Q25, aarch64, with LuneOS's node 22 and its webOS service
framework). There it is **LuneOS Explorer**: "Topaz" means nothing outside
the TouchPad. `tools/pack-luneos.sh` makes its package: the same files, with
that title, marked trusted (LuneOS's web runtime shows files from
`/media` only to trusted apps, so the pictures would stay blank), and
without the legacy webOS 7za. The app and its service find out for
themselves that they run on LuneOS (`/etc/luneos-release`) and use the name
in what they say.

Phones, the Q25's square screen included, show the files or the folders in
turn, each across the screen; the TouchPad and other tablets keep them side
by side. What else differs:

- **Archives** need LuneOS's 7-Zip (the `7zip` package: `/usr/bin/7z`, which
  reads RAR too). The 7za in this package is built for legacy webOS's
  soft-float ARM and cannot run there. Without 7-Zip, extracting and
  compressing say so; everything else works.
- **The device's name** comes from the system
  (`com.palm.properties.deviceNameShort`): "My Mindset", "My Q25"; on legacy
  webOS, "My TouchPad" as before.
- **"Allow System Changes"** leaves LuneOS's system disk as it is: it is
  writable already, so there is nothing to open, and closing does not make
  it read-only.
- **Built into a LuneOS image**, the app comes from LuneOS's own recipe
  rather than the package. The bus files for the service that the installer
  would otherwise write are in `files/sysbus`, and the recipe installs them
  from there. The `requiredPermissions` in `app/appinfo.json` say which
  system calls the app makes.

The 4 GB limit applies only where the storage is FAT, as on the TouchPad
under legacy webOS.

## A word on what it is allowed to do

Topaz Explorer runs its file service as root, outside the jail webOS puts other installed services in.
That is what lets it show the whole system, and with "Allow System Changes" switched on it can
change or delete files webOS needs to start. A mistake there can mean restoring the TouchPad with
webOS Doctor. It is a tool for people who want that reach.

## How it is built

An Enyo 1 app (`app/`) with a node service (`service/files.js`) that does the file work.

The ids start with `com.palm.` on purpose. webOS shuts every other installed service into a jail
that holds little besides `/media/internal`; services named `com.palm.*` run as they are, as root
(see `/usr/bin/run-js-service` on the device). The packager insists that a service id sits under
its package id, so the app carries the prefix too. On first start after an install the service
corrects its own private-bus role file, which the installer writes with no outbound rights; the
comment at the top of `service/files.js` has the details.

### The archiver

`service/bin/7za` is p7zip 16.02 built as one program with every format in it, RAR reading
included. `native/build-7z.sh` downloads the source and builds it with the webOS PDK's toolchain;
nothing of p7zip is kept in this repository but that program. p7zip is LGPL 2.1 or later; its RAR
code is under the unRAR license, which allows reading RAR archives and forbids using the code to
write them. Both licenses are in `native/`.

### Building

`tools\deploy.ps1` packages, installs and starts the app on a TouchPad attached by USB (Palm SDK
and Java needed; the paths are at the top of the script). `node tools\check.js` checks the code
against what the device's 2011 web engine and node 0.4 understand. `tools\make-icons.ps1` redraws
the images.

## License

GPL-3.0 for everything but `7za` (see above) and the libraries inside
`topaz-net`: libssh2 (BSD-3-Clause), OpenSSL 1.1.1 (OpenSSL license) and
libsmb2 (LGPL-2.1 or later); `native/build-net.sh` builds it from their
sources, and their licenses are in `native/`.
