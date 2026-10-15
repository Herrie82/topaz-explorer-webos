// File service for the Topaz Explorer app (node 0.4.12 on webOS 3 / webOS CE, ES5 only).
//
// A web app cannot look through the TouchPad's storage or change anything on
// it. This service lists folders and does the work of copying, moving and
// deleting.
//
// It can look at every folder on the TouchPad. It changes only the TouchPad's
// own storage, /media/internal, unless a call says system: true, which the app
// sends only after the person has switched on "Allow System Changes" and read
// the warning. Seeing everything is why its name
// starts with com.palm: the system shuts every other installed service into a
// jail that holds little besides /media/internal (see /usr/bin/run-js-service),
// and runs those named com.palm.* as they are.
//
// It can also open a folder on an FTP server, through the system's curl.
//
// Every answer carries "ok". A failure has ok: false and "error", a sentence
// the app can show. (returnValue cannot carry a failure back to an app.)

if (typeof require === "undefined") {
	require = IMPORTS.require;
}

var child_process = require("child_process");
var fs = require("fs");

var ROOT = "/media/internal";
var SERVICE = "palm://com.palm.stark.files.service/";
var CHUNK = 64 * 1024;
var MAX_FOUND = 500;       // search results returned at most
var MAX_DEPTH = 24;        // folders below folders followed at most
var MAX_TEXT = 300 * 1024;  // the largest file opened as text
var KID_CHECKS = 400;      // entries looked at to learn whether a folder has folders in it

// Folders that are not files on a disk: windows into the running system.
// They can be looked at, but never searched, measured or copied.
// The archiver. On legacy webOS: 7za from p7zip, with every format built in
// (native/build-7z.sh), started through the system's program loader, which does
// not need the file to be marked as a program: installing a package does not
// keep that mark. That 7za is built for webOS's soft-float ARM, so on LuneOS,
// which has neither that loader nor that ABI, the system's 7-Zip is used
// instead: 7z (with RAR reading) or 7za, from the 7zip package.
var SEVENZ = "/media/cryptofs/apps/usr/palm/services/com.palm.stark.files.service/bin/7za";
var LOADER = "/lib/ld-linux.so.3";
var SYSTEM_7Z = ["/usr/bin/7z", "/usr/bin/7za"];
// The biggest a single file can be on the TouchPad's storage (FAT32): 4 GB less
// one byte. An archive that would pass this, or a file inside one, is refused.
var FAT32MAX = 4294967295;
// Tar archives that are also compressed: unpacked in two stages.
var PACKED_TAR = /\.(tar\.(gz|bz2|xz|z)|tgz|tbz2?|txz)$/i;
var LIVE = ["/proc", "/sys", "/dev"];
// The device's short name for messages: "TouchPad" until the system says
// otherwise (com.palm.properties.deviceNameShort; LuneOS gives each its own).
var DEVICE = "TouchPad";
// Whether this is LuneOS, and the app's name in messages: there it is LuneOS
// Explorer, as "Topaz" (the TouchPad's name while it was being made) means
// nothing there.
var LUNEOS = false;
try {
	fs.statSync("/etc/luneos-release");
	LUNEOS = true;
} catch (eName) {}
var APP_NAME = LUNEOS ? "LuneOS Explorer" : "Topaz Explorer";
// Left behind while this service has the system disk open for changes.
var OPENED = "/tmp/.fm-system-open";

function log(msg) {
	try { console.log("[fmfiles] " + msg); } catch (e) {}
}

function fail(future, text) {
	future.result = {returnValue: true, ok: false, error: text};
	return future;
}

// ---- first start --------------------------------------------------------------
//
// The installer writes this service a pass for the system's private message
// bus that lets nothing out, and a service outside the jail does its own
// housekeeping (telling the system it is busy) over that bus. Until the pass
// is put right every call hangs. So the first time it starts after being
// installed, the service corrects its own pass and has the system read the
// passes again; the app's first call is asked again after a moment.
(function() {
	var pass = "/var/palm/ls2/roles/prv/com.palm.stark.files.service.json";
	var shut = /"outbound"\s*:\s*\[\s*\]/;
	// LuneOS keeps no such files; its installer writes the service's rights
	// itself, with outbound calls allowed.
	try {
		fs.statSync(pass);
	} catch (e0) {
		return;
	}
	try {
		var text = fs.readFileSync(pass, "utf8");
		if (shut.test(text)) {
			fs.writeFileSync(pass, text.replace(shut, "\"outbound\":[\"*\"]"));
			child_process.spawn("/usr/bin/ls-control", ["scan-services"]);
			log("corrected the private bus pass");
		}
	} catch (e) {
		log("could not check the private bus pass: " + e);
	}
})();

(function() {
	var key = "com.palm.properties.deviceNameShort";
	try {
		IMPORTS.foundations.Comms.PalmCall.call("palm://com.palm.preferences/systemProperties/", "Get", {key: key})
			.then(function(f) {
				try {
					if (f.result && f.result[key]) {
						DEVICE = String(f.result[key]);
					}
				} catch (e2) {}
			});
	} catch (e) {}
})();

// ---- paths --------------------------------------------------------------------

function join(dir, name) {
	return dir === "/" ? "/" + name : dir + "/" + name;
}

// Whether a path is on the TouchPad's own storage, where things may be changed.
function inside(path) {
	return path === ROOT || path.indexOf(ROOT + "/") === 0;
}

// Whether a path is in one of the live system folders.
function live(path) {
	for (var i = 0; i < LIVE.length; i++) {
		if (path === LIVE[i] || path.indexOf(LIVE[i] + "/") === 0) {
			return true;
		}
	}
	return false;
}

// A tidy absolute path, or null. Anything on the TouchPad may be looked at.
function clean(path) {
	path = String(path || "");
	if (path.charAt(0) !== "/") {
		return null;
	}
	var parts = path.split("/");
	var out = [];
	for (var i = 0; i < parts.length; i++) {
		if (parts[i] === "" || parts[i] === ".") {
			continue;
		}
		if (parts[i] === "..") {
			return null;
		}
		out.push(parts[i]);
	}
	return "/" + out.join("/");
}

// A folder that things may be put in, or null. system: system changes are
// allowed, which opens everything but the live folders.
function cleanFolder(path, system) {
	path = clean(path);
	return path && (inside(path) || (system && !live(path))) ? path : null;
}

// Something that may be renamed, moved or deleted, or null: never the storage
// itself, nor the top of the system.
function cleanItem(path, system) {
	path = cleanFolder(path, system);
	// Nor a folder at the top of the system (/usr, /var, /media...): nothing
	// good comes of renaming or deleting one of those whole.
	return !path || path === ROOT || path.lastIndexOf("/") === 0 ? null : path;
}

function parentOf(path) {
	return path.substring(0, path.lastIndexOf("/")) || "/";
}

function nameOf(path) {
	return path.substring(path.lastIndexOf("/") + 1);
}

// Why a name cannot be used in a folder, or "" when it can. The storage is
// FAT, which refuses more characters than the system's own disks do.
function badName(name, dir) {
	if (!name || /^\s*$/.test(name)) {
		return "Type a name first.";
	}
	if (name === "." || name === "..") {
		return "That name cannot be used.";
	}
	if (name.indexOf("/") >= 0) {
		return "A name cannot contain a slash.";
	}
	if (inside(dir) && /[\\:*?"<>|]/.test(name)) {
		return "A name cannot contain any of these: \\ / : * ? \" < > |";
	}
	if (name.length > 200) {
		return "That name is too long.";
	}
	return "";
}

// A few words more for a failure, where the system's reason is one people can act on.
function whyNot(e) {
	var text = String((e && (e.code || e.message)) || e);
	if (/EROFS/.test(text)) {
		return " This disk is read-only.";
	}
	if (/ENOSPC/.test(text)) {
		return " The disk is full.";
	}
	if (/EACCES|EPERM/.test(text)) {
		return " The system does not allow it.";
	}
	return "";
}

function stat(path) {
	try {
		return fs.lstatSync(path);
	} catch (e) {
		return null;
	}
}

// What is at a path, a link counting as what it points at: {st, link}, or null.
function look(path) {
	var st = stat(path);
	if (st && st.isSymbolicLink()) {
		try {
			return {st: fs.statSync(path), link: true};
		} catch (e) {
			return {st: st, link: true};      // a link to nothing
		}
	}
	return st ? {st: st, link: false} : null;
}

function exists(path) {
	return !!stat(path);
}

// The mount a path is on, from /proc/mounts: {dir, type, opts}, or null.
function mountOf(path) {
	var best = null;
	var lines;
	try {
		lines = fs.readFileSync("/proc/mounts", "utf8").split("\n");
	} catch (e) {
		return null;
	}
	for (var i = 0; i < lines.length; i++) {
		var f = lines[i].split(" ");
		if (f.length < 4) {
			continue;
		}
		var dir = f[1].replace(/\\040/g, " ");
		var under = dir === "/" || path === dir || path.indexOf(dir + "/") === 0;
		if (under && (!best || dir.length >= best.dir.length)) {
			best = {dir: dir, type: f[2], opts: f[3].split(",")};
		}
	}
	return best;
}

// Whether a file put at path is held to FAT's 4 GB. The TouchPad's storage is
// FAT32; LuneOS's is not. Where it cannot be told, it is taken to be.
function fatLimited(path) {
	var m = mountOf(path);
	return !m || /^(vfat|msdos|fat)$/.test(m.type);
}

// How to start the archiver: {program, args} (args before 7za's own), or null.
function archiver() {
	if (exists(LOADER) && exists(SEVENZ)) {
		return {program: LOADER, args: [SEVENZ]};
	}
	for (var i = 0; i < SYSTEM_7Z.length; i++) {
		if (exists(SYSTEM_7Z[i])) {
			return {program: SYSTEM_7Z[i], args: []};
		}
	}
	return null;
}

// "Photo.jpg" -> "Photo (2).jpg", for the first number not in use.
function freeName(dir, name, isDir) {
	var dot = isDir ? -1 : name.lastIndexOf(".");
	var stem = dot > 0 ? name.substring(0, dot) : name;
	var ext = dot > 0 ? name.substring(dot) : "";
	for (var n = 2; n < 10000; n++) {
		var tryName = stem + " (" + n + ")" + ext;
		if (!exists(join(dir, tryName))) {
			return tryName;
		}
	}
	return stem + " (" + new Date().getTime() + ")" + ext;
}

// Whether a folder has a folder in it (for the arrow in the folder tree).
function hasFolders(dir) {
	var names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		return false;
	}
	var n = Math.min(names.length, KID_CHECKS);
	for (var i = 0; i < n; i++) {
		var seen = look(join(dir, names[i]));
		if (seen && seen.st.isDirectory()) {
			return true;
		}
	}
	return names.length > KID_CHECKS;
}

// ---- looking ------------------------------------------------------------------

// {path, folders, kids} -> {entries: [{n: name, d: 1 for a folder, s: size, m: modified,
//                                    l: 1 for a link, k: has folders}]}
// folders: only folders. kids: say for each folder whether it has folders in it.
var listAssistant = function() {};
listAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var path = clean(args.path);
	if (!path) {
		return fail(future, "That is not a folder on this " + DEVICE + ".");
	}
	var names;
	try {
		names = fs.readdirSync(path);
	} catch (e) {
		return fail(future, "That folder could not be opened. It may have been moved or deleted.");
	}
	var entries = [];
	for (var i = 0; i < names.length; i++) {
		var seen = look(join(path, names[i]));
		if (!seen) {
			continue;
		}
		var st = seen.st;
		var dir = st.isDirectory();
		if (args.folders && !dir) {
			continue;
		}
		var e = {n: names[i], d: dir ? 1 : 0, s: st.isFile() ? st.size : 0, m: st.mtime.getTime()};
		if (seen.link) {
			e.l = 1;
		}
		if (dir && args.kids) {
			e.k = hasFolders(join(path, names[i])) ? 1 : 0;
		}
		entries.push(e);
	}
	future.result = {returnValue: true, ok: true, path: path, entries: entries};
	return future;
};

// {path, text, hidden} -> {entries: [{p: folder, n, d, s, m}], more: true when cut short}
// Everything under a folder whose name contains the text.
var searchAssistant = function() {};
searchAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var path = clean(args.path);
	var text = String(args.text || "").toLowerCase();
	if (!path || !text) {
		return fail(future, "There is nothing to search for.");
	}
	if (live(path)) {
		return fail(future, "This folder shows the running system, not files on a disk. It cannot be searched.");
	}
	var found = [];
	var more = false;

	function walk(dir, depth) {
		var names;
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			return;
		}
		for (var i = 0; i < names.length; i++) {
			var name = names[i];
			if (!args.hidden && name.charAt(0) === ".") {
				continue;
			}
			var st = stat(join(dir, name));
			if (!st) {
				continue;
			}
			var isDir = st.isDirectory();
			if (name.toLowerCase().indexOf(text) >= 0) {
				if (found.length >= MAX_FOUND) {
					more = true;
					return;
				}
				found.push({p: dir, n: name, d: isDir ? 1 : 0, s: st.isFile() ? st.size : 0, m: st.mtime.getTime()});
			}
			// Links are not followed, so the search cannot go round in circles.
			if (isDir && depth < MAX_DEPTH && !live(join(dir, name))) {
				walk(join(dir, name), depth + 1);
				if (more) {
					return;
				}
			}
		}
	}

	walk(path, 0);
	future.result = {returnValue: true, ok: true, path: path, entries: found, more: more};
	return future;
};

// Add up everything at and under a path into {files, folders, bytes}.
// Links and devices count as things but have no size; links are not followed.
function measure(path, st, sum, depth) {
	if (!st.isDirectory()) {
		sum.files++;
		sum.bytes += st.isFile() ? st.size : 0;
		return;
	}
	sum.folders++;
	if (depth >= MAX_DEPTH || live(path)) {
		return;
	}
	var names;
	try {
		names = fs.readdirSync(path);
	} catch (e) {
		return;
	}
	for (var i = 0; i < names.length; i++) {
		var s2 = stat(join(path, names[i]));
		if (s2) {
			measure(join(path, names[i]), s2, sum, depth + 1);
		}
	}
}

// {paths} -> {files, folders, bytes, modified}: what the chosen things hold.
var detailsAssistant = function() {};
detailsAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var paths = args.paths || [];
	var sum = {files: 0, folders: 0, bytes: 0};
	var modified = 0;
	for (var i = 0; i < paths.length; i++) {
		var path = clean(paths[i]);
		var st = path && stat(path);
		if (!st) {
			continue;
		}
		modified = Math.max(modified, st.mtime.getTime());
		measure(path, st, sum, 0);
	}
	future.result = {returnValue: true, ok: true, files: sum.files, folders: sum.folders, bytes: sum.bytes,
		modified: modified};
	return future;
};

// {path} -> {free, total} in bytes for the disk a folder is on.
var spaceAssistant = function() {};
spaceAssistant.prototype.run = function(future) {
	var out = "";
	var child;
	var where = clean((this.controller.args || {}).path) || ROOT;
	if (live(where)) {
		return fail(future, "This folder is not on a disk.");
	}
	try {
		child = child_process.spawn("/bin/df", ["-k", where]);
	} catch (e) {
		return fail(future, "The free space could not be read.");
	}
	child.on("error", function() {
		fail(future, "The free space could not be read.");
	});
	child.stdout.on("data", function(d) { out += d.toString(); });
	child.on("exit", function() {
		// The numbers may sit on the line after a long device name.
		var m = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%/.exec(out.replace(/\n/g, " "));
		if (!m) {
			fail(future, "The free space could not be read.");
			return;
		}
		future.result = {returnValue: true, ok: true, total: Number(m[1]) * 1024, free: Number(m[3]) * 1024};
	});
	return future;
};

// ---- text ---------------------------------------------------------------------

// {path} -> {text, enc, crlf}: a file's contents as text, for the editor.
// enc and crlf say how it was stored, so it can be written back the same way.
// A file that is not text fails with binary: true.
var readAssistant = function() {};
readAssistant.prototype.run = function(future) {
	var path = clean((this.controller.args || {}).path);
	var seen = path && look(path);
	if (!seen || !seen.st.isFile() || live(path)) {
		return fail(future, "That cannot be opened as text.");
	}
	if (seen.st.size > MAX_TEXT) {
		return fail(future, "That file is too large to open here (over " + Math.round(MAX_TEXT / 1024) + " KB).");
	}
	var buf;
	try {
		buf = fs.readFileSync(path);
	} catch (e) {
		return fail(future, "That file could not be read." + whyNot(e));
	}
	var n = Math.min(buf.length, 8192);
	for (var i = 0; i < n; i++) {
		if (buf[i] === 0) {
			future.result = {returnValue: true, ok: false, binary: true, error: "That file is not text."};
			return future;
		}
	}
	// Most text is UTF-8. What is not is taken a byte to a character, which
	// shows old Western files rightly and writes any file back unharmed.
	var enc = "utf8";
	var text = buf.toString("utf8");
	if (text.indexOf("\uFFFD") >= 0) {
		enc = "binary";
		text = buf.toString("binary");
	}
	var crlf = text.indexOf("\r\n") >= 0;
	if (crlf) {
		text = text.replace(/\r\n/g, "\n");
	}
	future.result = {returnValue: true, ok: true, text: text, enc: enc, crlf: crlf};
	return future;
};

// {path, text, enc, crlf, system} -> {size}: write a text file back. The new
// contents go to a file beside it first, which then takes its place, so a
// failure part way never leaves half a file.
var writeAssistant = function() {};
writeAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var path = clean(args.path);
	if (!path || !(inside(path) || (args.system && !live(path)))) {
		return fail(future, "That file cannot be changed.");
	}
	var text = String(args.text === undefined ? "" : args.text);
	if (args.crlf) {
		text = text.replace(/\r?\n/g, "\r\n");
	}
	var old = look(path);
	var beside = path + ".fm-saving";
	try {
		fs.writeFileSync(beside, text, args.enc === "binary" ? "binary" : "utf8");
		if (old && !inside(path)) {
			// The system's disks keep who owns a file and who may read or run it.
			try { fs.chmodSync(beside, old.st.mode & 4095); } catch (e1) {}
			try { fs.chownSync(beside, old.st.uid, old.st.gid); } catch (e2) {}
		}
		fs.renameSync(beside, path);
	} catch (e) {
		log("write " + path + ": " + e);
		try { fs.unlinkSync(beside); } catch (e3) {}
		return fail(future, "The file could not be saved." + whyNot(e));
	}
	var now = stat(path);
	future.result = {returnValue: true, ok: true, size: now ? now.size : 0};
	return future;
};

// ---- small changes ------------------------------------------------------------

// {path, name} -> {path}: a new folder in a folder.
var mkdirAssistant = function() {};
mkdirAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var dir = cleanFolder(args.path, args.system);
	var name = String(args.name || "").replace(/^\s+|\s+$/g, "");
	if (!dir) {
		return fail(future, "Folders cannot be made here.");
	}
	var bad = badName(name, dir);
	if (bad) {
		return fail(future, bad);
	}
	if (exists(join(dir, name))) {
		return fail(future, "There is already something named \"" + name + "\" here.");
	}
	try {
		fs.mkdirSync(join(dir, name), 493 /* 0755 */);
	} catch (e) {
		log("mkdir " + join(dir, name) + ": " + e);
		return fail(future, "The folder could not be made." + whyNot(e));
	}
	future.result = {returnValue: true, ok: true, path: join(dir, name)};
	return future;
};

// {path, name} -> {path}: a new name for a file or folder, in the same place.
var renameAssistant = function() {};
renameAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var path = cleanItem(args.path, args.system);
	var name = String(args.name || "").replace(/^\s+|\s+$/g, "");
	if (!path) {
		return fail(future, "That cannot be renamed.");
	}
	var bad = badName(name, parentOf(path));
	if (!exists(path)) {
		return fail(future, "That could not be found. It may have been moved or deleted.");
	}
	if (bad) {
		return fail(future, bad);
	}
	var to = parentOf(path) + "/" + name;
	if (to === path) {
		future.result = {returnValue: true, ok: true, path: to};
		return future;
	}
	// FAT keeps the capitals of a name but does not tell names apart by them,
	// so a change of capitals alone finds "itself" in the way.
	var caseOnly = inside(path) && to.toLowerCase() === path.toLowerCase();
	if (!caseOnly && exists(to)) {
		return fail(future, "There is already something named \"" + name + "\" here.");
	}
	try {
		if (caseOnly) {
			var between = path + ".fm-renaming";
			fs.renameSync(path, between);
			fs.renameSync(between, to);
		} else {
			fs.renameSync(path, to);
		}
	} catch (e) {
		log("rename " + path + " -> " + to + ": " + e);
		return fail(future, "The name could not be changed." + whyNot(e));
	}
	future.result = {returnValue: true, ok: true, path: to};
	return future;
};

// {on} -> {on}: open the system disk for changes, or close it again. webOS keeps
// the disk it starts from read-only; /var and the storage are always writable.
// Closing only undoes an opening of our own, so a disk someone opened by other
// means is left as they set it.
var unlockAssistant = function() {};
unlockAssistant.prototype.run = function(future) {
	var on = !!(this.controller.args || {}).on;
	if (!on && !exists(OPENED)) {
		future.result = {returnValue: true, ok: true, on: false};
		return future;
	}
	var root = mountOf("/");
	if (on && root && root.opts.indexOf("rw") >= 0) {
		// Already writable (as on LuneOS): nothing to open, and so nothing for
		// closing to make read-only afterwards.
		future.result = {returnValue: true, ok: true, on: true};
		return future;
	}
	var child;
	try {
		child = child_process.spawn("/bin/mount", ["-o", on ? "remount,rw" : "remount,ro", "/"]);
	} catch (e) {
		return fail(future, "The system disk could not be " + (on ? "opened." : "closed."));
	}
	child.on("error", function() {
		fail(future, "The system disk could not be " + (on ? "opened." : "closed."));
	});
	child.on("exit", function(code) {
		log("system disk " + (on ? "opened" : "closed") + " for changes: mount said " + code);
		if (code !== 0) {
			fail(future, "The system disk could not be " + (on ? "opened for changes." : "made read-only again; it is busy. It will be read-only after a restart."));
			return;
		}
		try {
			if (on) {
				fs.writeFileSync(OPENED, "");
			} else {
				fs.unlinkSync(OPENED);
			}
		} catch (e2) {}
		future.result = {returnValue: true, ok: true, on: on};
	});
	return future;
};

// ---- jobs: copy, move, delete -------------------------------------------------
//
// One job runs at a time. "start" answers at once; the app then asks "status"
// a few times a second and may send "cancel".

var job = null;
var jobCount = 0;
var keepAwake = null;

function snapshot() {
	if (!job) {
		return {returnValue: true, ok: true, running: false, id: 0};
	}
	return {
		returnValue: true, ok: true,
		id: job.id, op: job.op, running: !job.finished, cancelled: job.cancelled,
		stage: job.stage,                        // "counting" or "working"
		bytes: job.bytes, doneBytes: job.doneBytes,
		things: job.things, doneThings: job.doneThings,   // files and folders, all the way down
		items: job.items, doneItems: job.doneItems,
		percent: job.percent || 0,               // 7za's own 0-100 for archives
		started: job.started || 0,               // when work began, for an estimate
		current: job.current,
		failed: job.failed,                      // how many things could not be done
		firstError: job.firstError,
		note: job.note || "",                    // a sentence to show when it is over
		password: !!job.password                 // the archive wants a password
	};
}

function jobError(path, why) {
	job.failed++;
	if (!job.firstError) {
		job.firstError = nameOf(path);
	}
	log(job.op + " " + path + ": " + why);
}

function finish() {
	job.finished = true;
	job.current = "";
	if (job.sizeWatch) {
		clearInterval(job.sizeWatch);
		job.sizeWatch = null;
	}
	if (keepAwake) {
		clearInterval(keepAwake);
		keepAwake = null;
	}
	log(job.op + " finished: " + job.doneItems + " of " + job.items + ", " + job.failed + " failed" +
		(job.cancelled ? ", cancelled" : ""));
}

// The service is shut down when nobody has called it for a while. A long copy
// must outlive the app's card being closed, so the job calls its own service.
function stayAwake() {
	if (keepAwake) {
		return;
	}
	keepAwake = setInterval(function() {
		try {
			IMPORTS.foundations.Comms.PalmCall.call(SERVICE, "status", {});
		} catch (e) {}
	}, 30000);
}

// Run steps one after another without holding up "status" and "cancel".
// A step is function(next); the list may grow while it runs.
function runSteps(steps, done) {
	var busy = 0;
	function next() {
		if (job.cancelled || !steps.length) {
			done();
			return;
		}
		var step = steps.shift();
		// Give other calls a turn now and then; not every time, which is slow.
		if (++busy % 20 === 0) {
			setTimeout(function() { step(next); }, 0);
		} else {
			step(next);
		}
	}
	next();
}

// Copy one file, counting bytes as they go. done(error)
function copyFile(from, to, st, done) {
	var rs, ws;
	var ended = false;
	function end(err) {
		if (ended) {
			return;
		}
		ended = true;
		if (err) {
			try { rs.destroy(); } catch (e1) {}
			try { ws.destroy(); } catch (e2) {}
			try { fs.unlinkSync(to); } catch (e3) {}
		} else {
			try { fs.utimesSync(to, st.atime, st.mtime); } catch (e4) {}
			if (!inside(to)) {
				// The system's disks keep who may read and run a file; FAT does not.
				try { fs.chmodSync(to, st.mode & 4095); } catch (e5) {}
			}
		}
		done(err);
	}
	try {
		rs = fs.createReadStream(from, {bufferSize: CHUNK, highWaterMark: CHUNK});
		ws = fs.createWriteStream(to);
	} catch (e) {
		done(e);
		return;
	}
	rs.on("data", function(d) {
		if (job.cancelled) {
			end("cancelled");
			return;
		}
		job.doneBytes += d.length;
		if (ws.write(d) === false) {
			rs.pause();
		}
	});
	ws.on("drain", function() {
		try { rs.resume(); } catch (e) {}
	});
	rs.on("end", function() { ws.end(); });
	ws.on("close", function() { end(null); });
	rs.on("error", end);
	ws.on("error", end);
}

// Delete a file or a whole folder. Links are removed, never followed.
function removeAll(path, st, counted) {
	if (st.isDirectory()) {
		var names = [];
		try {
			names = fs.readdirSync(path);
		} catch (e) {}
		for (var i = 0; i < names.length && !job.cancelled; i++) {
			var s2 = stat(join(path, names[i]));
			if (s2) {
				removeAll(join(path, names[i]), s2, counted);
			}
		}
		if (job.cancelled) {
			return;
		}
		try {
			fs.rmdirSync(path);
		} catch (e2) {
			jobError(path, e2);
		}
	} else {
		try {
			fs.unlinkSync(path);
			if (counted) {
				job.doneBytes += st.size;
			}
		} catch (e3) {
			jobError(path, e3);
		}
	}
}

// Steps that count what is at and under a path, a folder at a time, so the job
// can say how far along it is. top: the selected thing this belongs to.
function countSteps(list, path, st, top) {
	list.push(function(next) {
		function add(s1) {
			var n = s1.isFile() ? s1.size : 0;
			job.things++;
			job.bytes += n;
			job.sizes[top] = (job.sizes[top] || 0) + n;
		}
		add(st);
		if (!st.isDirectory() || live(path)) {
			next();
			return;
		}
		job.current = nameOf(path);
		var names = [];
		try {
			names = fs.readdirSync(path);
		} catch (e) {}
		var inner = [];
		for (var i = 0; i < names.length; i++) {
			var s2 = stat(join(path, names[i]));
			if (!s2) {
				continue;
			}
			if (s2.isDirectory()) {
				countSteps(inner, join(path, names[i]), s2, top);
			} else {
				add(s2);
			}
		}
		Array.prototype.unshift.apply(job.steps, inner);
		next();
	});
}

// Steps that delete a file or a whole folder, one thing at a time, so the job
// can report on itself and be stopped part way. Links are removed, never followed.
function deleteSteps(list, path, st) {
	list.push(function(next) {
		if (!st.isDirectory()) {
			try {
				fs.unlinkSync(path);
				job.doneBytes += st.isFile() ? st.size : 0;
			} catch (e) {
				jobError(path, e);
			}
			job.doneThings++;
			next();
			return;
		}
		job.current = nameOf(path);
		var names = [];
		try {
			names = fs.readdirSync(path);
		} catch (e2) {}
		var inner = [];
		for (var i = 0; i < names.length; i++) {
			var s2 = stat(join(path, names[i]));
			if (s2) {
				deleteSteps(inner, join(path, names[i]), s2);
			}
		}
		// The folder itself goes once it is empty.
		inner.push(function(next2) {
			try {
				fs.rmdirSync(path);
			} catch (e3) {
				jobError(path, e3);
			}
			job.doneThings++;
			next2();
		});
		Array.prototype.unshift.apply(job.steps, inner);
		next();
	});
}

// Steps that copy one thing (file or folder) to a full destination path.
// mode: what to do when the destination exists: "replace", "skip" or "both".
function copySteps(steps, from, to, st, mode) {
	steps.push(function(next) {
		job.current = nameOf(from);
		// A link is copied as the file it points at. Folders behind links, and
		// things that are not files at all (devices, pipes), are left out.
		if (st.isSymbolicLink()) {
			try {
				st = fs.statSync(from);
			} catch (e0) {
				jobError(from, "a link to nothing");
				next();
				return;
			}
		}
		if (!st.isFile() && !st.isDirectory() || (st.isDirectory() && (live(from) || stat(from).isSymbolicLink()))) {
			jobError(from, "not a file or folder that can be copied");
			next();
			return;
		}
		var there = stat(to);
		if (there) {
			// "Skip" leaves files alone; a folder onto a folder is always merged.
			if (mode === "skip" && !(there.isDirectory() && st.isDirectory())) {
				job.doneBytes += job.sizes[from] !== undefined ? job.sizes[from] : (st.isDirectory() ? 0 : st.size);
				next();
				return;
			}
			if (mode === "both") {
				to = parentOf(to) + "/" + freeName(parentOf(to), nameOf(to), st.isDirectory());
				there = null;
			} else if (there.isDirectory() !== st.isDirectory()) {
				// A file where a folder goes, or the other way round: it gives way.
				removeAll(to, there, false);
				there = null;
			}
		}
		if (st.isDirectory()) {
			if (!there) {
				try {
					fs.mkdirSync(to, inside(to) ? 493 /* 0755 */ : (st.mode & 4095));
				} catch (e) {
					jobError(from, e);
					next();
					return;
				}
			}
			job.doneThings++;
			var names = [];
			try {
				names = fs.readdirSync(from);
			} catch (e2) {
				jobError(from, e2);
			}
			// Inside a folder that is being merged, the same answer applies; a
			// folder made new has nothing in the way.
			var inner = [];
			for (var i = 0; i < names.length; i++) {
				var s2 = stat(join(from, names[i]));
				if (s2) {
					copySteps(inner, join(from, names[i]), to + "/" + names[i], s2, mode === "both" ? "replace" : mode);
				}
			}
			Array.prototype.unshift.apply(job.steps, inner);
			next();
		} else {
			copyFile(from, to, st, function(err) {
				job.doneThings++;
				if (err && err !== "cancelled") {
					jobError(from, err);
				}
				next();
			});
		}
	});
}

// Steps that move one thing. Everything is on one storage, so a move is a
// rename unless something is in the way.
function moveSteps(steps, from, to, st, mode) {
	steps.push(function(next) {
		job.current = nameOf(from);
		var there = stat(to);
		if (there) {
			if (mode === "skip" && !(there.isDirectory() && st.isDirectory())) {
				next();
				return;
			}
			if (mode === "both") {
				to = parentOf(to) + "/" + freeName(parentOf(to), nameOf(to), st.isDirectory());
				there = null;
			} else if (there.isDirectory() && st.isDirectory()) {
				// Folder onto folder: move what is inside, then drop the emptied one.
				var names = [];
				try {
					names = fs.readdirSync(from);
				} catch (e) {}
				var inner = [];
				for (var i = 0; i < names.length; i++) {
					var s2 = stat(join(from, names[i]));
					if (s2) {
						moveSteps(inner, join(from, names[i]), to + "/" + names[i], s2, mode);
					}
				}
				inner.push(function(next2) {
					try { fs.rmdirSync(from); } catch (e3) {}
					next2();
				});
				Array.prototype.unshift.apply(job.steps, inner);
				next();
				return;
			} else {
				removeAll(to, there, false);
			}
		}
		try {
			fs.renameSync(from, to);
		} catch (e4) {
			if (/EXDEV/.test(String((e4 && (e4.code || e4.message)) || e4))) {
				// Another disk: copy it across, and remove the original only if
				// every part of it arrived.
				var failedBefore = job.failed;
				var across = [];
				copySteps(across, from, to, st, "replace");
				across.push(function(next3) {
					if (job.failed === failedBefore && !job.cancelled) {
						removeAll(from, st, false);
					}
					next3();
				});
				Array.prototype.unshift.apply(job.steps, across);
			} else {
				jobError(from, e4);
			}
		}
		next();
	});
}

// ---- network folders (FTP) -----------------------------------------------------
//
// A folder on an FTP server is reached with the curl the system has
// (/usr/bin/curl; on webOS CE it speaks FTP, FTPS and modern TLS). One site
// at a time is "opened": the app signs in with netOpen and gets a number to
// call the site by. The name and password go to curl as its configuration on
// its input, never on the command line where another process could read them.
//
// Copies go both ways through the same "start" command as local ones, with a
// net number: from the site they download, to it they upload. A move takes
// the source away at the end, but only when every part arrived.

var nets = {};          // id -> {base, user, pass, extra}
var netCount = 0;
var CURL = "/usr/bin/curl";
var NET_CONNECT = 10;   // seconds to reach the server
var NET_LIST_TIME = 25; // seconds to list a folder

// The parts of "ftp://user:pass@host:port/start", or null.
function parseNet(url) {
	url = String(url || "").replace(/^\s+|\s+$/g, "");
	var m = /^(ftps?):\/\/(?:([^:@\/]*)(?::([^@\/]*))?@)?([^\/:]+)(?::(\d+))?(\/.*)?$/i.exec(url);
	if (!m) {
		return null;
	}
	function plain(s) {
		try {
			return decodeURIComponent(s || "");
		} catch (e) {
			return s || "";
		}
	}
	return {scheme: m[1].toLowerCase(), user: plain(m[2]), pass: plain(m[3]),
		host: m[4], port: m[5] ? Number(m[5]) : 0, start: m[6] || "/"};
}

// Whether a path an app sent is a folder or file on a site.
function isNetPath(path) {
	return /^ftps?:\/\//i.test(String(path || ""));
}

// A tidy path on a site ("/dir/sub", "/" at worst), or null.
function cleanNetPath(path) {
	path = String(path || "/");
	if (path.charAt(0) !== "/") {
		path = "/" + path;
	}
	var parts = path.split("/");
	var out = [];
	for (var i = 0; i < parts.length; i++) {
		if (!parts[i] || parts[i] === ".") {
			continue;
		}
		if (parts[i] === "..") {
			return null;
		}
		out.push(parts[i]);
	}
	return "/" + out.join("/");
}

// A URL for something on the site: each part of the path encoded, slashes
// kept, so names with spaces and the like reach the server whole. curl is
// told --globoff so [ and { in names are not read as patterns.
function netUrl(site, path) {
	var enc = [];
	var parts = String(path || "/").split("/");
	for (var i = 0; i < parts.length; i++) {
		if (parts[i]) {
			enc.push(encodeURIComponent(parts[i]));
		}
	}
	return site.base + enc.join("/");
}

// A URL for listing a folder: with the trailing slash, curl lists the folder
// instead of trying to fetch a file by that name.
function netDirUrl(site, path) {
	return path === "/" ? site.base : netUrl(site, path) + "/";
}

// Run curl once for a site. done(code, errorText, listingText). The sign-in
// is written to curl's input; a job's children are kept so Cancel can stop
// them.
function runCurl(site, args, done) {
	var out = "";
	var err = "";
	var code = 255;
	var child;
	try {
		child = child_process.spawn(CURL, ["-K", "-", "--silent", "--show-error", "--globoff",
			"--connect-timeout", String(NET_CONNECT)].concat(site.extra || []).concat(args), {cwd: "/"});
	} catch (e) {
		setTimeout(function() {
			done(255, String(e), "");
		}, 0);
		return;
	}
	if (job && !job.finished) {
		job.kids = job.kids || [];
		job.kids.push(child);
	}
	var ended = false;
	function finish() {
		if (ended) {
			return;
		}
		ended = true;
		if (job && job.kids) {
			var at = job.kids.indexOf(child);
			if (at >= 0) {
				job.kids.splice(at, 1);
			}
		}
		done(code, err, out);
	}
	child.stdout.on("data", function(d) {
		out += d.toString();
	});
	child.stderr.on("data", function(d) {
		err += d.toString();
	});
	child.on("exit", function(c) {
		code = c === null || c === undefined ? 255 : c;
		finish();
	});
	// The name and password, as curl's configuration, on its input. A site
	// with no name is signed in as anonymous.
	function quoted(s) {
		return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n]/g, " ");
	}
	var user = site.user || "anonymous";
	var pass = site.pass || (user === "anonymous" ? "topaz@" : "");
	try {
		child.stdin.write("user = \"" + quoted(user) + ":" + quoted(pass) + "\"\n");
		child.stdin.end();
	} catch (e2) {}
}
// What to say when the site did not answer as hoped.
function netWhyText(code, err) {
	err = String(err || "");
	if (/530|login or password|authentication|password required/i.test(err) || code === 67) {
		return "The server refused the name or password.";
	}
	if (code === 6 || code === 7 || code === 8) {
		return "Could not reach the server.";
	}
	if (code === 28) {
		return "The server took too long to answer.";
	}
	if (code === 78 || /550|no such/i.test(err)) {
		return "That is not on the server, or the server would not show it.";
	}
	if (code === 18) {
		return "The transfer was cut short.";
	}
	log("curl said " + code + ": " + err.replace(/\s+/g, " ").substring(0, 200));
	return "The server did not do what was asked.";
}

var NET_MONTHS = {jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11};

// One line of a folder listing as the server wrote it (the UNIX "ls -l"
// kind, or the older MS-DOS kind), or null. -> {n, d, s, m} like list's.
function parseNetLine(line) {
	line = String(line || "").replace(/[\r\s]+$/, "");
	if (!line || /^total \d+$/i.test(line)) {
		return null;
	}
	var m = /^([\-dl])[rwxsStT+\-]{9}.*?\s+(\d+)\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}|\d{1,2}:\d{2})\s+(.+)$/.exec(line);
	if (m) {
		var name = m[7];
		if (name === "." || name === "..") {
			return null;
		}
		var dir = m[1] === "d";
		if (m[1] === "l" && name.indexOf(" -> ") >= 0) {
			// A link: what it points at cannot be known without following it.
			name = name.substring(0, name.indexOf(" -> "));
		}
		return {n: name, d: dir ? 1 : 0, s: Number(m[3]), m: netDate(m[4], m[5], m[6])};
	}
	// "10-23-20  03:25PM  5401 file.txt" (or <DIR> instead of a size)
	m = /^(\d{2})-(\d{2})-(\d{2,4})\s+\d{2}:\d{2}(AM|PM)?\s+(<DIR>|\d+)\s+(.+)$/i.exec(line);
	if (m) {
		if (m[6] === "." || m[6] === "..") {
			return null;
		}
		var y = Number(m[3]);
		y = y < 100 ? 2000 + y : y;
		var mo = Number(m[1]) - 1;
		return {n: m[6], d: m[5] === "<DIR>" ? 1 : 0, s: m[5] === "<DIR>" ? 0 : Number(m[5]),
			m: new Date(y, mo >= 0 && mo < 12 ? mo : 0, Number(m[2])).getTime()};
	}
	return null;
}

// "Mar 31 2023", or "Mar 31 14:05" (this year, or last if that is ahead).
function netDate(mon, day, rest) {
	var mo = NET_MONTHS[String(mon).toLowerCase()];
	if (mo === undefined) {
		return 0;
	}
	var d = Number(day);
	var now = new Date();
	if (rest.indexOf(":") > 0) {
		var y = now.getFullYear();
		if (new Date(y, mo, d).getTime() > now.getTime()) {
			y--;
		}
		return new Date(y, mo, d).getTime();
	}
	return new Date(Number(rest), mo, d).getTime();
}

// A name not used in a folder listing, like freeName but for the site.
function freeNetName(taken, name, isDir) {
	if (!taken[String(name).toLowerCase()]) {
		return name;
	}
	var dot = isDir ? -1 : name.lastIndexOf(".");
	var stem = dot > 0 ? name.substring(0, dot) : name;
	var ext = dot > 0 ? name.substring(dot) : "";
	for (var n = 2; n < 1000; n++) {
		var tryName = stem + " (" + n + ")" + ext;
		if (!taken[tryName.toLowerCase()]) {
			return tryName;
		}
	}
	return stem + " (" + new Date().getTime() + ")" + ext;
}

// The entries of a folder listing, or null with err when it failed.
function netListOnce(site, path, done) {
	runCurl(site, ["--max-time", String(NET_LIST_TIME), netDirUrl(site, path)], function(code, err, out) {
		if (code !== 0) {
			done(netWhyText(code, err), null);
			return;
		}
		var entries = [];
		var lines = out.split(/\r?\n/);
		for (var i = 0; i < lines.length; i++) {
			var e = parseNetLine(lines[i]);
			if (e) {
				entries.push(e);
			}
		}
		done("", entries);
	});
}

// {url} -> {id}: open a site, trying the sign-in at once so a wrong name or
// password is told here. The url may carry them: "ftp://user:pass@host/".
// login: true in the answer means the app should ask for them.
var netOpenAssistant = function() {};
netOpenAssistant.prototype.run = function(future) {
	var site = parseNet((this.controller.args || {}).url);
	if (!site) {
		return fail(future, "That is not an ftp:// or ftps:// address.");
	}
	var port = site.port || 21;
	// ftps on 990 speaks TLS from the start; anywhere else it is asked for
	// after signing in, which is what servers mostly do.
	var implicit = site.scheme === "ftps" && (site.port || 0) === 990;
	var s = {
		base: (implicit ? "ftps://" : "ftp://") + site.host + ":" + port + "/",
		user: site.user,
		pass: site.pass,
		extra: site.scheme === "ftps" && !implicit ? ["--ssl-reqd"] : []
	};
	runCurl(s, ["--max-time", String(NET_LIST_TIME), s.base], function(code, err) {
		if (code === 0) {
			nets[++netCount] = s;
			log("site opened: " + s.base);
			future.result = {returnValue: true, ok: true, id: netCount};
			return;
		}
		if (/530|login or password|authentication|password required/i.test(err) || code === 67) {
			future.result = {returnValue: true, ok: false, login: true, error: "The server refused the name or password."};
			return;
		}
		fail(future, netWhyText(code, err));
	});
	return future;
};

// {id}: the site is no longer needed.
var netCloseAssistant = function() {};
netCloseAssistant.prototype.run = function(future) {
	delete nets[(this.controller.args || {}).id];
	future.result = {returnValue: true, ok: true};
	return future;
};

// {id, path} -> {entries}: a folder on the site, shaped like list's.
var netListAssistant = function() {};
netListAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = nets[args.id];
	var path = cleanNetPath(args.path);
	if (!site || !path) {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	netListOnce(site, path, function(err, entries) {
		if (err) {
			return fail(future, err);
		}
		future.result = {returnValue: true, ok: true, entries: entries};
	});
	return future;
};// {id, path, name} -> {path}: a new name on the site.
var netRenameAssistant = function() {};
netRenameAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = nets[args.id];
	var path = cleanNetPath(args.path);
	var name = String(args.name || "").replace(/^\s+|\s+$/g, "");
	if (!site || !path || path === "/") {
		return fail(future, "That cannot be renamed.");
	}
	var bad = badName(name, "");
	if (bad) {
		return fail(future, bad);
	}
	var to = parentOf(path) === "/" ? "/" + name : parentOf(path) + "/" + name;
	runCurl(site, ["--max-time", "20", "-Q", "RNFR " + path, "-Q", "RNTO " + to, site.base],
		function(code, err) {
			if (code !== 0) {
				return fail(future, netWhyText(code, err));
			}
			future.result = {returnValue: true, ok: true, path: to};
		});
	return future;
};

// {id, path, name} -> {path}: a new folder on the site.
var netMkdirAssistant = function() {};
netMkdirAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = nets[args.id];
	var path = cleanNetPath(args.path);
	var name = String(args.name || "").replace(/^\s+|\s+$/g, "");
	if (!site || !path) {
		return fail(future, "Folders cannot be made here.");
	}
	var bad = badName(name, "");
	if (bad) {
		return fail(future, bad);
	}
	var made = path === "/" ? "/" + name : path + "/" + name;
	runCurl(site, ["--max-time", "20", "-Q", "MKD " + made, site.base], function(code, err) {
		if (code !== 0) {
			if (/exist|521|550/i.test(String(err || ""))) {
				return fail(future, "There is already something named \"" + name + "\" here.");
			}
			return fail(future, netWhyText(code, err));
		}
		future.result = {returnValue: true, ok: true, path: made};
	});
	return future;
};

// Steps that bring one thing down from the site. A folder is walked: each
// folder is listed, its files come down into a folder of their own, and what
// is in the way locally gets a number, like "Keep Both".
function netDownSteps(steps, site, remote, local, isDir, size) {
	steps.push(function(next) {
		job.current = nameOf(remote);
		if (!isDir) {
			job.things++;
			job.bytes += size || 0;
			var target = exists(local) ?
				join(parentOf(local), freeName(parentOf(local), nameOf(local), false)) : local;
			runCurl(site, ["-o", target, netUrl(site, remote)], function(code, err) {
				job.doneThings++;
				var st = stat(target);
				job.doneBytes += st ? st.size : 0;
				if (code !== 0 && !job.cancelled) {
					try { fs.unlinkSync(target); } catch (e1) {}
					jobError(remote, netWhyText(code, err));
				}
				next();
			});
			return;
		}
		job.things++;
		var dir = local;
		if (!exists(dir)) {
			try {
				fs.mkdirSync(dir, 493 /* 0755 */);
			} catch (e2) {
				jobError(remote, e2);
				next();
				return;
			}
		}
		job.doneThings++;
		netListOnce(site, remote, function(err, entries) {
			if (err) {
				jobError(remote, err);
				next();
				return;
			}
			var inner = [];
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				netDownSteps(inner, site, remote === "/" ? "/" + e.n : remote + "/" + e.n,
					join(dir, e.n), !!e.d, e.s);
			}
			Array.prototype.unshift.apply(job.steps, inner);
			next();
		});
	});
}

// Steps that take one thing up to the site. A folder is made there if it is
// not there already, and merged if it is; a name already taken gets a number.
// (countSteps has already counted everything there is to send.)
function netUpSteps(steps, site, from, remote, st) {
	steps.push(function(next) {
		job.current = nameOf(from);
		if (!st.isDirectory()) {
			runCurl(site, ["-T", from, netUrl(site, remote)], function(code, err) {
				job.doneThings++;
				job.doneBytes += st.isFile() ? st.size : 0;
				if (code !== 0 && !job.cancelled) {
					jobError(from, netWhyText(code, err));
				}
				next();
			});
			return;
		}
		job.doneThings++;
		// The folder is made if it is not there (a failure to make it because
		// it is already there is fine: it is merged, like a local copy).
		runCurl(site, ["--max-time", "20", "-Q", "MKD " + remote, site.base], function() {
			netListOnce(site, remote, function(err, entries) {
				var taken = {};
				if (!err) {
					for (var i = 0; i < entries.length; i++) {
						taken[entries[i].n.toLowerCase()] = true;
					}
				}
				var names = [];
				try {
					names = fs.readdirSync(from);
				} catch (e2) {
					jobError(from, e2);
				}
				var inner = [];
				for (var k = 0; k < names.length; k++) {
					var s2 = stat(join(from, names[k]));
					if (s2) {
						var toName = freeNetName(taken, names[k], s2.isDirectory());
						taken[toName.toLowerCase()] = true;
						netUpSteps(inner, site, join(from, names[k]),
							remote === "/" ? "/" + toName : remote + "/" + toName, s2);
					}
				}
				Array.prototype.unshift.apply(job.steps, inner);
				next();
			});
		});
	});
}

// Steps that take one thing off the site: a folder is emptied first.
function netDeleteSteps(steps, site, remote, isDir) {
	steps.push(function(next) {
		job.current = nameOf(remote);
		if (!isDir) {
			runCurl(site, ["--max-time", "20", "-Q", "DELE " + remote, site.base], function(code, err) {
				job.doneThings++;
				if (code !== 0 && !job.cancelled) {
					jobError(remote, netWhyText(code, err));
				}
				next();
			});
			return;
		}
		netListOnce(site, remote, function(err, entries) {
			if (err) {
				jobError(remote, err);
				next();
				return;
			}
			var inner = [];
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				netDeleteSteps(inner, site, remote === "/" ? "/" + e.n : remote + "/" + e.n, !!e.d);
			}
			// The folder itself goes once it is empty.
			inner.push(function(next2) {
				runCurl(site, ["--max-time", "20", "-Q", "RMD " + remote, site.base], function(code2, err2) {
					job.doneThings++;
					if (code2 !== 0 && !job.cancelled) {
						jobError(remote, netWhyText(code2, err2));
					}
					next2();
				});
			});
			Array.prototype.unshift.apply(job.steps, inner);
			next();
		});
	});
}

// {op: copy|move|delete, net: id, paths, dest}: the same jobs as start, with
// one side on the site. Copy brings things down when the paths are on the
// site, and takes them up when the destination is; move does that and then
// takes the source away, but only if every part arrived.
function startNet(future, args, op) {
	var site = nets[args.net];
	if (!site) {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	var paths = args.paths || [];
	var i;
	var items = [];
	var down = paths.length > 0 && isNetPath(paths[0]);

	if (down) {
		var dest = null;
		if (op !== "delete") {
			dest = cleanFolder(args.dest, args.system);
			var dst = dest && stat(dest);
			if (!dst || !dst.isDirectory()) {
				return fail(future, "The folder to put them in could not be found.");
			}
		}
		for (i = 0; i < paths.length; i++) {
			if (!isNetPath(paths[i])) {
				return fail(future, "Things from the site and from this TouchPad cannot go in one job.");
			}
			var rp = cleanNetPath(paths[i].substring(paths[i].indexOf("/", paths[i].indexOf("://") + 3)));
			if (!rp || rp === "/") {
				return fail(future, "That cannot be copied from the site.");
			}
			items.push({remote: rp, to: dest ? join(dest, nameOf(rp)) : ""});
		}
		if (!items.length) {
			return fail(future, "Those could not be found. They may have been moved or deleted.");
		}
	} else {
		if (op !== "copy" && op !== "move") {
			return fail(future, "That cannot be done on the site.");
		}
		var updest = String(args.dest || "");
		if (!isNetPath(updest)) {
			return fail(future, "That folder is not on the site being shown.");
		}
		var upath = cleanNetPath(updest.substring(updest.indexOf("/", updest.indexOf("://") + 3)));
		if (!upath) {
			return fail(future, "That folder is not on the site being shown.");
		}
		for (i = 0; i < paths.length; i++) {
			var p = clean(paths[i]);
			var st = p && stat(p);
			if (st) {
				items.push({local: p, st: st, to: upath});
			}
		}
		if (!items.length) {
			return fail(future, "Those could not be found. They may have been moved or deleted.");
		}
	}

	job = {
		id: ++jobCount, op: op, finished: false, cancelled: false, stage: "counting",
		bytes: 0, doneBytes: 0, things: 0, doneThings: 0, items: items.length, doneItems: 0, current: "",
		failed: 0, firstError: "", sizes: {}
	};
	stayAwake();
	var steps = [];
	job.steps = steps;
	log(op + " (net) started: " + items.length + " item(s)");

	if (down) {
		// First learn from each folder's listing what the things are (folders
		// or files, and what the files weigh), then the work follows.
		steps.push(function(next) {
			job.stage = "working";
			var byParent = {};
			for (var m = 0; m < items.length; m++) {
				var par = parentOf(items[m].remote) || "/";
				(byParent[par] = byParent[par] || []).push(items[m]);
			}
			var parents = [];
			for (var k in byParent) {
				if (byParent.hasOwnProperty(k)) {
					parents.push({path: k, items: byParent[k]});
				}
			}
			var at = 0;
			(function classify() {
				if (job.cancelled || at >= parents.length) {
					next();
					return;
				}
				var group = parents[at++];
				job.current = nameOf(group.path);
				netListOnce(site, group.path, function(err, entries) {
					if (err) {
						jobError(group.path, err);
						for (var q = 0; q < group.items.length; q++) {
							jobError(group.items[q].remote, "the folder could not be listed");
						}
						classify();
						return;
					}
					var known = {};
					for (var i2 = 0; i2 < entries.length; i2++) {
						known[entries[i2].n] = entries[i2];
					}
					var work = [];
					for (var i3 = 0; i3 < group.items.length; i3++) {
						var it = group.items[i3];
						var found = known[nameOf(it.remote)];
						if (!found) {
							jobError(it.remote, "not on the server any more");
							continue;
						}
						it.isDir = !!found.d;
						if (op === "delete") {
							netDeleteSteps(work, site, it.remote, it.isDir);
						} else {
							netDownSteps(work, site, it.remote, it.to, it.isDir, found.s || 0);
						}
					}
					Array.prototype.unshift.apply(job.steps, work);
					classify();
				});
			})();
		});
		// A move takes the source off the site only when every part arrived.
		if (op === "move") {
			steps.push(function(next) {
				if (job.failed === 0 && !job.cancelled) {
					var clean = [];
					for (var c = 0; c < items.length; c++) {
						// What is a folder was learned while classifying.
						netDeleteSteps(clean, site, items[c].remote, !!items[c].isDir);
					}
					Array.prototype.unshift.apply(job.steps, clean);
				}
				next();
			});
		}
	} else {
		// Learn how much there is to send, so the bar can show real progress.
		for (i = 0; i < items.length; i++) {
			countSteps(steps, items[i].local, items[i].st, items[i].local);
		}
		// What is already in the folder on the site, so what goes up gets a
		// name of its own when something is in the way ("Keep Both").
		steps.push(function(next) {
			netListOnce(site, upath, function(err, entries) {
				job.stage = "working";
				if (!err) {
					var taken = {};
					for (var t = 0; t < entries.length; t++) {
						taken[entries[t].n.toLowerCase()] = true;
					}
					for (var t2 = 0; t2 < items.length; t2++) {
						var nm = freeNetName(taken, nameOf(items[t2].local), items[t2].st.isDirectory());
						taken[nm.toLowerCase()] = true;
						items[t2].toName = nm;
					}
				}
				next();
			});
		});
		for (i = 0; i < items.length; i++) {
			(function(it) {
				var to = it.toName || nameOf(it.local);
				netUpSteps(steps, site, it.local, it.to === "/" ? "/" + to : it.to + "/" + to, it.st);
				steps.push(function(next) {
					job.doneItems++;
					next();
				});
			})(items[i]);
		}
		// A move takes the originals away only when every part arrived.
		if (op === "move") {
			steps.push(function(next) {
				if (job.failed === 0 && !job.cancelled) {
					for (var c = 0; c < items.length; c++) {
						deleteSteps(steps, items[c].local, items[c].st);
					}
				}
				next();
			});
		}
	}

	setTimeout(function() {
		runSteps(steps, finish);
	}, 10);
	future.result = {returnValue: true, ok: true, id: job.id};
	return future;
}

// ---- archives -----------------------------------------------------------------

// Run 7za: once, or twice with the first one's output piped into the second.
// onLine gets each line the last one prints; done(code, errors) when all have
// ended, with the worst exit code (0 fine, 1 warnings, 2 and up failure).
function sevenZip(argLists, cwd, onLine, done) {
	var kids = [];
	var errors = "";
	var left = "";
	var ended = 0;
	var worst = 0;
	function line(text) {
		if (/^(ERROR|WARNING)/.test(text) || /password/i.test(text)) {
			errors += text + "\n";
		}
		onLine(text);
	}
	function exited(code) {
		if (this && this.ended) {
			return;
		}
		if (this) {
			this.ended = true;
		}
		worst = Math.max(worst, code === null || code === undefined ? 255 : code);
		if (++ended === kids.length) {
			job.kill = null;
			if (left) {
				line(left);
			}
			done(worst, errors);
		}
	}
	var how = archiver();
	if (!how) {
		job.kill = null;
		done(255, "No archiver");
		return;
	}
	try {
		for (var i = 0; i < argLists.length; i++) {
			kids.push(child_process.spawn(how.program, how.args.concat(argLists[i]), {cwd: cwd || "/"}));
		}
	} catch (e) {
		done(255, String(e));
		return;
	}
	var first = kids[0];
	var last = kids[kids.length - 1];
	for (var k = 0; k < kids.length; k++) {
		kids[k].stderr.on("data", function(d) { errors += d.toString(); });
		kids[k].on("exit", exited);
		// A program that cannot be started: node reports it here, and without a
		// listener the whole service would stop.
		kids[k].on("error", function(e) {
			errors += String(e) + "\n";
			exited.call(this, 255);
		});
	}
	// Nothing to type at: a question (a password, say) fails at once instead of waiting.
	first.stdin.end();
	if (kids.length > 1) {
		first.stdout.on("data", function(d) {
			try {
				if (last.stdin.write(d) === false) {
					first.stdout.pause();
				}
			} catch (e2) {}
		});
		last.stdin.on("drain", function() {
			try { first.stdout.resume(); } catch (e3) {}
		});
		last.stdin.on("error", function() {});
		first.stdout.on("end", function() {
			try { last.stdin.end(); } catch (e4) {}
		});
	}
	last.stdout.on("data", function(d) {
		// 7za writes its running percentage with carriage returns, so split on
		// those too or the progress never reaches onLine until a newline.
		var lines = (left + d.toString()).split(/\r\n|\r|\n/);
		left = lines.pop();
		for (var n = 0; n < lines.length; n++) {
			line(lines[n]);
		}
	});
	job.kill = function() {
		for (var n = 0; n < kids.length; n++) {
			try { kids[n].kill(); } catch (e5) {}
		}
	};
}

// What to tell the person when 7za did not end cleanly. what: "extracted" or "made".
function archiveNote(code, errors, what) {
	if (/^No archiver/.test(errors)) {
		return "There is no archiver on this device (7-Zip).";
	}
	if (/password|encrypted/i.test(errors)) {
		job.password = true;
		return "This archive needs a password.";
	}
	if (/No space left/i.test(errors)) {
		return "The disk is full.";
	}
	if (/Can ?not open .* as archive|is not archive|Unsupported/i.test(errors)) {
		return "That is not an archive " + APP_NAME + " can read.";
	}
	return code === 1 ? "Some of it could not be " + what + "." : "The archive could not be " + what + ".";
}

// {op: "extract", paths: [archive], dest, folder, password}
//     Unpack an archive into dest, or into a new folder there when folder is named.
//     Nothing already there is overwritten: a file in the way gets a number added.
// {op: "pack", paths, dest, name}
//     Make an archive of things from one folder. The kind follows the name:
//     .7z, .tar, or else .zip.
function startArchive(future, args, op) {
	var paths = args.paths || [];
	var dest = cleanFolder(args.dest, args.system);
	var steps = [];
	var i;
	if (!dest || !exists(dest)) {
		return fail(future, args.system ? "Nothing can be put in this folder." :
			"Archives can only be " + (op === "pack" ? "made" : "extracted") + " on the " + DEVICE + "'s own storage, unless Allow System Changes is switched on.");
	}

	if (op === "extract") {
		var archive = clean(paths[0]);
		var seen = archive && look(archive);
		if (!seen || !seen.st.isFile() || live(archive)) {
			return fail(future, "That archive could not be found.");
		}
		var target = dest;
		var folder = String(args.folder || "").replace(/^\s+|\s+$/g, "");
		if (folder) {
			var bad = badName(folder, dest);
			if (bad) {
				return fail(future, bad);
			}
			if (exists(join(dest, folder))) {
				folder = freeName(dest, folder, true);
			}
			target = join(dest, folder);
			try {
				fs.mkdirSync(target, 493 /* 0755 */);
			} catch (e) {
				return fail(future, "The folder to extract into could not be made." + whyNot(e));
			}
		}
		var pw = args.password ? ["-p" + String(args.password)] : [];
		var packedTar = PACKED_TAR.test(archive);
		job = {
			id: ++jobCount, op: op, finished: false, cancelled: false, stage: "counting",
			bytes: 0, doneBytes: 0, things: 0, doneThings: 0, items: 1, doneItems: 0, current: nameOf(archive),
			percent: 0, started: 0, failed: 0, firstError: "", sizes: {}, steps: steps
		};
		stayAwake();
		log("extract started: " + archive + " to " + target);
		// How many things are in it, for the bar. (A compressed tar would have to
		// be unpacked once just to count; it is extracted without a total.)
		if (!packedTar) {
			steps.push(function(next) {
				var n = 0;
				var biggest = 0;
				sevenZip([["l", "-slt"].concat(pw, [archive])], "/", function(text) {
					if (/^Path = /.test(text)) {
						n++;
					}
					var sm = /^Size = (\d+)/.exec(text);
					if (sm) {
						var sz = parseInt(sm[1], 10);
						if (sz > biggest) {
							biggest = sz;
						}
					}
				}, function(code, errors) {
					// The first Path line is the archive itself.
					job.things = Math.max(0, n - 1);
					if (biggest > FAT32MAX && fatLimited(target) && !job.cancelled) {
						// FAT32 cannot hold a file over 4 GB, so it would fail part way.
						job.failed = 1;
						job.note = "Something inside is over 4 GB, which is too big for the " + DEVICE + "'s storage. It was not extracted.";
						steps.length = 0;
						if (folder) {
							try { fs.rmdirSync(target); } catch (e5) {}
						}
						next();
						return;
					}
					if (code >= 2 && !job.cancelled) {
						job.failed = 1;
						job.note = archiveNote(code, errors, "extracted");
						log("extract: " + errors.replace(/\s+/g, " ").substring(0, 300));
						steps.length = 0;
						if (folder) {
							try { fs.rmdirSync(target); } catch (e2) {}
						}
					}
					next();
				});
			});
		}
		steps.push(function(next) {
			job.stage = "working";
			job.started = new Date().getTime();
			var out = ["-y", "-aou", "-bb1", "-bso1", "-bsp0", "-o" + target];
			var lists = packedTar ?
				[["x", "-y", "-so"].concat(pw, [archive]), ["x", "-si", "-ttar"].concat(out)] :
				[["x"].concat(out, pw, [archive])];
			sevenZip(lists, "/", function(text) {
				// Each file prints "- name" as it comes out; that streams, so the
				// count climbs in real time even though the percentage would not.
				if (text.substring(0, 2) === "- ") {
					job.doneThings++;
					job.current = nameOf("/" + text.substring(2));
				}
			}, function(code, errors) {
				if (code !== 0 && !job.cancelled) {
					job.failed = 1;
					job.note = archiveNote(code, errors, "extracted");
					log("extract: " + errors.replace(/\s+/g, " ").substring(0, 300));
					if (folder && job.password) {
						// A wrong or missing password leaves only empty files, in
						// a folder made a moment ago for this: take it away again.
						var made = stat(target);
						if (made) {
							removeAll(target, made, false);
						}
					} else if (folder) {
						// If nothing came out, do not leave an empty folder behind.
						try { fs.rmdirSync(target); } catch (e4) {}
					}
				}
				job.doneItems = 1;
				next();
			});
		});
	} else {
		var name = String(args.name || "").replace(/^\s+|\s+$/g, "");
		var kind = /\.7z$/i.test(name) ? "7z" : (/\.tar$/i.test(name) ? "tar" : "zip");
		if (name && kind === "zip" && !/\.zip$/i.test(name)) {
			name += ".zip";
		}
		var badZip = badName(name, dest);
		if (badZip) {
			return fail(future, badZip);
		}
		var made = join(dest, name);
		if (exists(made)) {
			return fail(future, "There is already something named \"" + name + "\" here.");
		}
		var from = "";
		var names = [];
		var items = [];
		for (i = 0; i < paths.length; i++) {
			var p = clean(paths[i]);
			var st = p && p !== "/" && !live(p) && stat(p);
			if (!st) {
				continue;
			}
			if (from && parentOf(p) !== from) {
				return fail(future, "Things from different folders cannot go into one archive in one go.");
			}
			from = parentOf(p);
			names.push(nameOf(p));
			items.push({path: p, st: st});
		}
		if (!items.length) {
			return fail(future, "Those could not be found. They may have been moved or deleted.");
		}
		job = {
			id: ++jobCount, op: op, finished: false, cancelled: false, stage: "counting",
			bytes: 0, doneBytes: 0, things: 0, doneThings: 0, items: items.length, doneItems: 0, current: "",
			percent: 0, started: 0, failed: 0, firstError: "", sizes: {}, steps: steps
		};
		stayAwake();
		log("pack started: " + items.length + " item(s) into " + made);
		for (i = 0; i < items.length; i++) {
			countSteps(steps, items[i].path, items[i].st, items[i].path);
		}
		steps.push(function(next) {
			job.stage = "working";
			job.started = new Date().getTime();
			if (job.bytes > FAT32MAX && fatLimited(made)) {
				// Even stored, this would make a file too big for FAT32.
				job.failed = 1;
				job.note = "That is over 4 GB, too big for a single file on the " + DEVICE + "'s storage. Nothing was made.";
				next();
				return;
			}
			// The names are given relative to their folder, so the archive holds
			// them without the path that leads there.
			// The percentage 7za can print does not reach us until the end (it is
			// one long line with no break), so follow the archive's own growing
			// size instead: that moves in real time, however slow the packing.
			job.sizeWatch = setInterval(function() {
				try {
					var sz = fs.statSync(made).size;
					job.doneBytes = sz > job.bytes ? job.bytes : sz;
				} catch (eSize) {}
			}, 500);
			sevenZip([["a", "-t" + kind, "-y", "-bb1", "-bso1", "-bsp0", made, "--"].concat(names)], from, function(text) {
				if (text.substring(0, 2) === "+ ") {
					job.doneThings++;
					job.current = nameOf("/" + text.substring(2));
				}
			}, function(code, errors) {
				if (job.sizeWatch) {
					clearInterval(job.sizeWatch);
					job.sizeWatch = null;
				}
				if (job.cancelled || code >= 2) {
					// Half an archive is no use to anyone.
					try { fs.unlinkSync(made); } catch (e3) {}
				}
				if (code !== 0 && !job.cancelled) {
					job.failed = 1;
					job.note = archiveNote(code, errors, "made");
					log("pack: " + errors.replace(/\s+/g, " ").substring(0, 300));
				}
				job.doneItems = items.length;
				next();
			});
		});
	}

	setTimeout(function() {
		runSteps(steps, finish);
	}, 10);
	future.result = {returnValue: true, ok: true, id: job.id};
	return future;
}

// {op: "copy" | "move" | "delete", paths, dest, mode}
//   -> {id} once started, or {conflicts: [names]} when things at the destination
//      are in the way and no mode ("replace", "skip", "both") was given.
var startAssistant = function() {};
startAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var op = String(args.op || "");
	var mode = String(args.mode || "");
	var dest = null;
	var items = [];
	var i;

	if (job && !job.finished) {
		return fail(future, APP_NAME + " is still busy with the last thing you asked for.");
	}
	if (op === "extract" || op === "pack") {
		return startArchive(future, args, op);
	}
	if (op !== "copy" && op !== "move" && op !== "delete") {
		return fail(future, "Unknown job.");
	}
	if (args.net) {
		return startNet(future, args, op);
	}
	var paths = args.paths || [];
	for (i = 0; i < paths.length; i++) {
		// Anything may be copied from; only the storage may be taken from.
		var p = op === "copy" ? clean(paths[i]) : cleanItem(paths[i], args.system);
		if (!p) {
			return fail(future, args.system ? "That cannot be moved or deleted." :
				"System files can only be moved or deleted with Allow System Changes switched on.");
		}
		if (p === "/" || live(p)) {
			return fail(future, "\"" + (nameOf(p) || "/") + "\" shows the running system, not files on a disk. It cannot be copied.");
		}
		var st = stat(p);
		if (st) {
			items.push({path: p, st: st});
		}
	}
	if (!items.length) {
		return fail(future, "Those could not be found. They may have been moved or deleted.");
	}

	if (op !== "delete") {
		dest = cleanFolder(args.dest, args.system);
		if (!dest) {
			return fail(future, args.system ? "Nothing can be put in this folder." :
				"Things can only be put in system folders with Allow System Changes switched on.");
		}
		var dst = stat(dest);
		if (!dst || !dst.isDirectory()) {
			return fail(future, "The folder to put them in could not be found.");
		}
		var conflicts = [];
		for (i = 0; i < items.length; i++) {
			var it = items[i];
			if (it.st.isDirectory() && (dest === it.path || dest.indexOf(it.path + "/") === 0)) {
				return fail(future, "\"" + nameOf(it.path) + "\" cannot be put inside itself.");
			}
			it.to = dest + "/" + nameOf(it.path);
			if (parentOf(it.path) === dest) {
				if (op === "move") {
					return fail(future, "Those are already in this folder.");
				}
				// A copy beside the original always gets a name of its own.
				it.own = true;
			} else if (exists(it.to)) {
				conflicts.push(nameOf(it.path));
			}
		}
		if (conflicts.length && mode !== "replace" && mode !== "skip" && mode !== "both") {
			future.result = {returnValue: true, ok: true, conflicts: conflicts};
			return future;
		}
	}

	job = {
		id: ++jobCount, op: op, finished: false, cancelled: false, stage: "counting",
		bytes: 0, doneBytes: 0, things: 0, doneThings: 0, items: items.length, doneItems: 0, current: "",
		failed: 0, firstError: "", sizes: {}
	};
	stayAwake();
	log(op + " started: " + items.length + " item(s)" + (dest ? " to " + dest : ""));

	// The one list of steps the job runs; a folder adds the steps for what is in it
	// to the front of this list as it is reached.
	var steps = [];
	job.steps = steps;
	// First learn how much there is, so the bar can show real progress.
	if (op !== "move") {
		for (i = 0; i < items.length; i++) {
			countSteps(steps, items[i].path, items[i].st, items[i].path);
		}
	}
	steps.push(function(next) {
		job.stage = "working";
		next();
	});
	for (i = 0; i < items.length; i++) {
		(function(it) {
			if (op === "delete") {
				deleteSteps(steps, it.path, it.st);
			} else if (op === "copy") {
				copySteps(steps, it.path, it.to, it.st, it.own ? "both" : mode);
			} else {
				moveSteps(steps, it.path, it.to, it.st, mode);
			}
			steps.push(function(next) {
				job.doneItems++;
				next();
			});
		})(items[i]);
	}
	// Leave the first answer time to go out before the work begins.
	setTimeout(function() {
		runSteps(steps, finish);
	}, 10);

	future.result = {returnValue: true, ok: true, id: job.id};
	return future;
};

// -> how the job is getting on (see snapshot).
var statusAssistant = function() {};
statusAssistant.prototype.run = function(future) {
	var r = snapshot();
	r.app = APP_NAME;    // the app takes its name from here
	r.luneos = LUNEOS;
	future.result = r;
	return future;
};

// Stop the job. What was already done stays done.
// {} -> {}: stop the service. LuneOS's installer asks this of a package's
// services before it replaces them, and gives up on the update if they do not
// answer. A running job is cancelled; the service exits once it has answered.
var quitAssistant = function() {};
quitAssistant.prototype.run = function(future) {
	if (job && !job.finished) {
		job.cancelled = true;
		if (job.kill) {
			job.kill();
		}
	}
	future.result = {returnValue: true, ok: true};
	setTimeout(function() {
		process.exit(0);
	}, 200);
	return future;
};

var cancelAssistant = function() {};
cancelAssistant.prototype.run = function(future) {
	if (job && !job.finished) {
		job.cancelled = true;
		if (job.kill) {
			job.kill();
		}
		// The transfers the job is running just now.
		if (job.kids) {
			for (var i = 0; i < job.kids.length; i++) {
				try { job.kids[i].kill(); } catch (e) {}
			}
		}
	}
	future.result = snapshot();
	return future;
};
