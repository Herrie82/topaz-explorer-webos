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
		password: !!job.password,                // the archive wants a password
		result: job.result || ""                 // what a job made, where the app needs it (fetch)
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
	if (job.close) {
		job.close();
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

// ---- network folders (FTP, SFTP, SMB) ------------------------------------------
//
// One site at a time per address is "opened": the app signs in with netOpen
// and gets a number to call the site by.
//
// FTP and FTPS go through the curl the system has (/usr/bin/curl; on webOS CE
// it speaks FTP, FTPS and modern TLS). The name and password go to curl as its
// configuration on its input, never on the command line where another process
// could read them.
//
// SFTP and SMB (2 and 3) go through bin/topaz-net, built from native/ with
// libssh2 and libsmb2. One runs per connection and is kept for many requests,
// a line at a time on its input and output (see native/topaz-net.c); the
// sign-in goes the same way. A job gets a connection of its own, so the
// folders can still be looked through while it runs.
//
// SFTP servers are known by their key: the first time, the app shows the
// key's fingerprint and the person says whether to trust it; after that a
// server showing another key is refused until they say so again.
//
// Copies go both ways through the same "start" command as local ones, with a
// net number: from the site they download, to it they upload. A move takes
// the source away at the end, but only when every part arrived.

var nets = {};          // id -> site: {kind: "ftp"|"sftp"|"smb", root, ...}
var netCount = 0;
var CURL = "/usr/bin/curl";
var NET_CONNECT = 10;   // seconds to reach the server
var NET_LIST_TIME = 25; // seconds to list a folder
// The SFTP and SMB program, started through the system's program loader like
// 7za (installing a package does not keep the mark that makes it a program).
var NET_TOOL = "/media/cryptofs/apps/usr/palm/services/com.palm.stark.files.service/bin/topaz-net";
var NET_IDLE = 120000;  // a connection unused this long is closed
// Private keys tried for SFTP before the password, when they are there.
var SSH_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

// ---- settings kept between runs (known SFTP servers, FTP sharing) ----

var confAt = null;

// The folder for them: the system's preferences, or a hidden folder on the
// storage where that cannot be had.
function confDir() {
	if (confAt) {
		return confAt;
	}
	var dirs = ["/var/preferences/com.palm.stark.files", ROOT + "/.topaz-explorer"];
	for (var i = 0; i < dirs.length; i++) {
		try {
			fs.mkdirSync(dirs[i], 448 /* 0700 */);
		} catch (e) {}
		var st = stat(dirs[i]);
		if (st && st.isDirectory()) {
			confAt = dirs[i];
			return confAt;
		}
	}
	return null;
}

function readConf(name) {
	var dir = confDir();
	try {
		return JSON.parse(fs.readFileSync(dir + "/" + name, "utf8")) || {};
	} catch (e) {
		return {};
	}
}

// Written beside and then moved into place, so a failure never leaves half.
function writeConf(name, value) {
	var dir = confDir();
	if (!dir) {
		return false;
	}
	try {
		fs.writeFileSync(dir + "/" + name + ".new", JSON.stringify(value));
		fs.renameSync(dir + "/" + name + ".new", dir + "/" + name);
		return true;
	} catch (e) {
		log("could not keep " + name + ": " + e);
		return false;
	}
}

// ---- addresses ----

// The parts of "scheme://user:pass@host:port/start", or null. scheme is ftp,
// ftps, sftp or smb; an SMB name may carry its domain: "DOMAIN;name" or
// "DOMAIN\name".
function parseNet(url) {
	url = String(url || "").replace(/^\s+|\s+$/g, "");
	var m = /^(ftps?|sftp|smb|gdrive|nextcloud|davs?):\/\/(?:([^@\/]*)@)?([^\/:@]+)(?::(\d+))?(\/.*)?$/i.exec(url);
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
	var info = m[2] || "";
	var colon = info.indexOf(":");
	var user = plain(colon >= 0 ? info.substring(0, colon) : info);
	var pass = plain(colon >= 0 ? info.substring(colon + 1) : "");
	var domain = "";
	var cut = Math.max(user.indexOf(";"), user.indexOf("\\"));
	if (cut > 0) {
		domain = user.substring(0, cut);
		user = user.substring(cut + 1);
	}
	return {scheme: m[1].toLowerCase(), user: user, pass: pass, domain: domain,
		host: m[3], port: m[4] ? Number(m[4]) : 0, start: m[5] || "/"};
}

// Whether a path an app sent is a folder or file on a site.
function isNetPath(path) {
	return /^(ftps?|sftp|smb|gdrive|nextcloud|davs?):\/\//i.test(String(path || ""));
}

// The path on the site of a full address: "ftp://host/a/b" -> "/a/b".
function netPathOf(url) {
	url = String(url || "");
	var at = url.indexOf("/", url.indexOf("://") + 3);
	return at < 0 ? "/" : url.substring(at);
}

// A tidy path on a site ("/dir/sub", "/" at worst), or null. Calls may give
// the path alone or the whole address.
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

function netJoin(dir, name) {
	return dir === "/" ? "/" + name : dir + "/" + name;
}

// ---- FTP through curl ----

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

function ftpList(site, path, done) {
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

// ---- SFTP and SMB through topaz-net ----

// How to start topaz-net: {program, args}, or null where it cannot run. It is
// built for legacy webOS's soft-float ARM, as 7za is.
function netTool() {
	if (LUNEOS || !exists(NET_TOOL) || !exists(LOADER)) {
		return null;
	}
	return {program: LOADER, args: [NET_TOOL]};
}

function netEscape(s) {
	return String(s === undefined || s === null ? "" : s).replace(/[%\t\r\n]/g, function(c) {
		var h = c.charCodeAt(0).toString(16).toUpperCase();
		return "%" + (h.length < 2 ? "0" : "") + h;
	});
}

function netUnescape(s) {
	return String(s || "").replace(/%([0-9A-Fa-f]{2})/g, function(m, h) {
		return String.fromCharCode(parseInt(h, 16));
	});
}

// One running topaz-net, signed in to one site. Requests wait their turn.
function ToolConn(site) {
	this.site = site;
	this.child = null;
	this.queue = [];
	this.current = null;
	this.text = "";
	this.timer = null;
	this.openErr = null;
	this.hostkey = "";
}

// request(fields, onBytes(n), done(err {kind, msg} or null, lines [fields]))
ToolConn.prototype.request = function(fields, onBytes, done) {
	if (this.timer) {
		clearTimeout(this.timer);
		this.timer = null;
	}
	this.queue.push({fields: fields, onBytes: onBytes, done: done, lines: []});
	if (!this.child && !this.start()) {
		this.gone({kind: "tool", msg: ""});
		return;
	}
	this.pump();
};

ToolConn.prototype.start = function() {
	var self = this;
	var tool = netTool();
	var child;
	if (!tool) {
		return false;
	}
	try {
		child = child_process.spawn(tool.program, tool.args, {cwd: "/"});
	} catch (e) {
		log("topaz-net would not start: " + e);
		return false;
	}
	this.child = child;
	this.text = "";
	this.openErr = null;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", function(d) {
		self.text += d;
		var at;
		while ((at = self.text.indexOf("\n")) >= 0) {
			var line = self.text.substring(0, at);
			self.text = self.text.substring(at + 1);
			self.line(line);
		}
	});
	child.stderr.on("data", function(d) {
		log("topaz-net: " + String(d).replace(/\s+$/, ""));
	});
	child.stdin.on("error", function() {});
	child.on("exit", function() {
		if (self.child === child) {
			self.child = null;
			self.gone(self.openErr || {kind: "connect", msg: "the connection was lost"});
		}
	});
	var s = this.site;
	this.queue.unshift({open: true, lines: [], done: function(err, lines) {
		for (var i = 0; i < lines.length; i++) {
			if (lines[i][0] === "hostkey") {
				self.hostkey = lines[i][1];
			}
		}
		if (err) {
			// topaz-net ends itself; what waits fails with the same reason.
			self.openErr = err;
		}
	}, fields: ["open", s.kind, s.host, s.port ? String(s.port) : "", s.user, s.pass, s.domain || "",
		s.trust || "", (s.keys || []).join("|")]});
	return true;
};

ToolConn.prototype.pump = function() {
	if (this.current || !this.queue.length || !this.child) {
		return;
	}
	if (this.openErr) {
		return;      // the end is coming; gone() answers the rest
	}
	this.current = this.queue.shift();
	var line = [];
	for (var i = 0; i < this.current.fields.length; i++) {
		line.push(netEscape(this.current.fields[i]));
	}
	try {
		this.child.stdin.write(line.join("\t") + "\n");
	} catch (e) {}
};

ToolConn.prototype.line = function(text) {
	var f = text.split("\t");
	for (var i = 0; i < f.length; i++) {
		f[i] = netUnescape(f[i]);
	}
	var cur = this.current;
	if (!cur) {
		return;
	}
	if (f[0] === "ok" || f[0] === "err") {
		this.current = null;
		cur.done(f[0] === "err" ? {kind: f[1] || "io", msg: f[2] || ""} : null, cur.lines);
		this.pump();
		if (!this.current && !this.queue.length && this.child) {
			var self = this;
			this.timer = setTimeout(function() {
				self.quit();
			}, NET_IDLE);
		}
		return;
	}
	if (f[0] === "p") {
		if (cur.onBytes) {
			cur.onBytes(Number(f[1]) || 0);
		}
		return;
	}
	cur.lines.push(f);
};

// The program ended: everything waiting fails with the reason.
ToolConn.prototype.gone = function(err) {
	var list = (this.current ? [this.current] : []).concat(this.queue);
	this.current = null;
	this.queue = [];
	for (var i = 0; i < list.length; i++) {
		list[i].done(err, list[i].lines);
	}
};

ToolConn.prototype.quit = function() {
	if (this.timer) {
		clearTimeout(this.timer);
		this.timer = null;
	}
	if (this.child) {
		try {
			this.child.stdin.write("quit\n");
			this.child.stdin.end();
		} catch (e) {}
	}
};

ToolConn.prototype.kill = function() {
	if (this.child) {
		try { this.child.kill(); } catch (e) {}
	}
};

// What to say for a topaz-net failure.
function netToolWhy(err) {
	switch (err.kind) {
	case "auth":
		return "The server refused the name or password.";
	case "connect":
		return err.msg === "the connection was lost" ? "The connection to the server was lost." :
			"Could not reach the server" + (err.msg && !/^could not reach/i.test(err.msg) ? " (" + err.msg + ")" : "") + ".";
	case "hostkey":
		return "The server's identity could not be confirmed.";
	case "notfound":
		return "That is not on the server, or the server would not show it.";
	case "exists":
		return "There is already something by that name there.";
	case "denied":
		return err.msg === "files go in a shared folder, not beside them" ||
			err.msg === "shared folders themselves cannot be changed from here" ?
			"Open one of the shared folders first: " + err.msg + "." :
			"The server would not allow that.";
	case "notempty":
		return "The folder on the server is not empty.";
	case "local":
		return "It could not be written on this " + DEVICE + " (" + err.msg + ").";
	case "tool":
		return LUNEOS ? "SFTP and SMB folders are not available on LuneOS yet." :
			"The SFTP and SMB helper is missing. Install " + APP_NAME + " again.";
	}
	log("topaz-net said " + err.kind + ": " + err.msg);
	return "The server did not do what was asked" + (err.msg ? " (" + err.msg + ")" : "") + ".";
}

// ---- one way to work on any site ----
// Each done(errorText, ...) gets "" when it worked.

function siteList(site, path, done) {
	if (site.kind === "dav") {
		davList(site, path, done);
		return;
	}
	if (site.kind === "gdrive") {
		driveList(site, path, done);
		return;
	}
	if (site.kind === "ftp") {
		ftpList(site, path, done);
		return;
	}
	site.conn.request(["ls", path], null, function(err, lines) {
		if (err) {
			done(netToolWhy(err), null);
			return;
		}
		var entries = [];
		for (var i = 0; i < lines.length; i++) {
			var f = lines[i];
			if (f[0] === "e" && f[4]) {
				entries.push({n: f[4], d: f[1] === "1" ? 1 : 0, s: Number(f[2]) || 0, m: (Number(f[3]) || 0) * 1000});
			}
		}
		done("", entries);
	});
}

function siteGet(site, remote, local, onBytes, done) {
	if (site.kind === "dav") {
		davGet(site, remote, local, done);
		return;
	}
	if (site.kind === "gdrive") {
		driveGet(site, remote, local, done);
		return;
	}
	if (site.kind === "ftp") {
		runCurl(site, ["-o", local, netUrl(site, remote)], function(code, err) {
			done(code === 0 ? "" : netWhyText(code, err));
		});
		return;
	}
	site.conn.request(["get", remote, local], onBytes, function(err) {
		done(err ? netToolWhy(err) : "");
	});
}

function sitePut(site, local, remote, onBytes, done) {
	if (site.kind === "dav") {
		davPut(site, local, remote, done);
		return;
	}
	if (site.kind === "gdrive") {
		drivePut(site, local, remote, done);
		return;
	}
	if (site.kind === "ftp") {
		runCurl(site, ["-T", local, netUrl(site, remote)], function(code, err) {
			done(code === 0 ? "" : netWhyText(code, err));
		});
		return;
	}
	site.conn.request(["put", local, remote], onBytes, function(err) {
		done(err ? netToolWhy(err) : "");
	});
}

// done(errorText, already): already is true when the folder was there.
function siteMkdir(site, path, done) {
	if (site.kind === "dav") {
		davMkdir(site, path, done);
		return;
	}
	if (site.kind === "gdrive") {
		driveMkdir(site, path, done);
		return;
	}
	if (site.kind === "ftp") {
		runCurl(site, ["--max-time", "20", "-Q", "MKD " + path, site.base], function(code, err) {
			if (code === 0) {
				done("", false);
			} else {
				done(netWhyText(code, err), /exist|521|550/i.test(String(err || "")));
			}
		});
		return;
	}
	site.conn.request(["mkdir", path], null, function(err) {
		done(err ? netToolWhy(err) : "", !!err && err.kind === "exists");
	});
}

function siteRename(site, from, to, done) {
	if (site.kind === "dav") {
		davMove(site, from, to, done);
		return;
	}
	if (site.kind === "gdrive") {
		driveRename(site, from, to, done);
		return;
	}
	if (site.kind === "ftp") {
		runCurl(site, ["--max-time", "20", "-Q", "RNFR " + from, "-Q", "RNTO " + to, site.base], function(code, err) {
			done(code === 0 ? "" : netWhyText(code, err));
		});
		return;
	}
	site.conn.request(["mv", from, to], null, function(err) {
		done(err ? netToolWhy(err) : "");
	});
}

// Take away a file, or a folder that is already empty.
function siteRemove(site, path, isDir, done) {
	if (site.kind === "dav") {
		davDelete(site, path, done);
		return;
	}
	if (site.kind === "gdrive") {
		driveTrash(site, path, done);
		return;
	}
	if (site.kind === "ftp") {
		runCurl(site, ["--max-time", "20", "-Q", (isDir ? "RMD " : "DELE ") + path, site.base], function(code, err) {
			done(code === 0 ? "" : netWhyText(code, err));
		});
		return;
	}
	site.conn.request([isDir ? "rmdir" : "rm", path], null, function(err) {
		done(err ? netToolWhy(err) : "");
	});
}

// A copy of a site with a connection of its own, for a job.
function jobSite(site) {
	if (site.kind === "ftp" || site.kind === "gdrive" || site.kind === "dav") {
		return site;
	}
	var copy = {};
	for (var k in site) {
		if (site.hasOwnProperty(k)) {
			copy[k] = site[k];
		}
	}
	copy.conn = new ToolConn(copy);
	return copy;
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

// {url, trust} -> {id, home}: open a site, trying the sign-in at once so a
// wrong name or password is told here. The url may carry them:
// "sftp://user:pass@host/". In the answer:
//   login: true      the app should ask for the name and password;
//   hostkey: "SHA256:..." (SFTP) the server's key is not known, or changed:
//                    true when another was known; to go on, the app asks
//                    again with trust: that fingerprint.
//   home             the folder the server starts a session in (SFTP).
var netOpenAssistant = function() {};
netOpenAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = parseNet(args.url);
	if (!site) {
		return fail(future, "That is not an ftp://, sftp:// or smb:// address.");
	}
	if (site.scheme === "nextcloud" || site.scheme === "dav" || site.scheme === "davs") {
		davOpen(site, function(err, d, login) {
			if (err) {
				future.result = {returnValue: true, ok: false, login: !!login && site.scheme !== "nextcloud", error: err};
				return;
			}
			nets[++netCount] = d;
			log("site opened: " + site.scheme + "://" + site.host);
			future.result = {returnValue: true, ok: true, id: netCount, home: "/"};
		});
		return future;
	}
	if (site.scheme === "gdrive") {
		driveOpen(function(err, d) {
			if (err) {
				return fail(future, err);
			}
			nets[++netCount] = d;
			log("Google Drive opened");
			future.result = {returnValue: true, ok: true, id: netCount, home: "/", email: d.email};
		});
		return future;
	}
	if (site.scheme === "ftp" || site.scheme === "ftps") {
		var port = site.port || 21;
		// ftps on 990 speaks TLS from the start; anywhere else it is asked for
		// after signing in, which is what servers mostly do.
		var implicit = site.scheme === "ftps" && (site.port || 0) === 990;
		var s = {
			kind: "ftp",
			base: (implicit ? "ftps://" : "ftp://") + site.host + ":" + port + "/",
			user: site.user,
			pass: site.pass,
			extra: site.scheme === "ftps" && !implicit ? ["--ssl-reqd"] : []
		};
		runCurl(s, ["--max-time", String(NET_LIST_TIME), s.base], function(code, err) {
			if (code === 0) {
				nets[++netCount] = s;
				log("site opened: " + s.base);
				future.result = {returnValue: true, ok: true, id: netCount, home: "/"};
				return;
			}
			if (/530|login or password|authentication|password required/i.test(err) || code === 67) {
				future.result = {returnValue: true, ok: false, login: true, error: "The server refused the name or password."};
				return;
			}
			fail(future, netWhyText(code, err));
		});
		return future;
	}

	// SFTP and SMB
	var where = site.host + ":" + (site.port || (site.scheme === "sftp" ? 22 : 445));
	var known = readConf("known_hosts.json");
	var t = {kind: site.scheme, host: site.host, port: site.port, user: site.user, pass: site.pass,
		domain: site.domain, keys: []};
	if (site.scheme === "sftp") {
		t.trust = String(args.trust || known[where] || "");
		for (var k = 0; k < SSH_KEYS.length; k++) {
			if (exists(ROOT + "/.ssh/" + SSH_KEYS[k])) {
				t.keys.push(ROOT + "/.ssh/" + SSH_KEYS[k]);
			}
		}
		if (!t.user) {
			// SFTP always signs in as someone.
			future.result = {returnValue: true, ok: false, login: true, error: "Type the name to sign in with."};
			return future;
		}
	}
	t.conn = new ToolConn(t);
	t.conn.request(["home"], null, function(err, lines) {
		if (err) {
			t.conn.kill();
			if (err.kind === "hostkey") {
				future.result = {returnValue: true, ok: false, hostkey: t.conn.hostkey,
					changed: !!known[where] && known[where] !== t.conn.hostkey,
					error: "The server's identity could not be confirmed."};
			} else if (err.kind === "auth") {
				future.result = {returnValue: true, ok: false, login: true, error: netToolWhy(err)};
			} else {
				fail(future, netToolWhy(err));
			}
			return;
		}
		if (site.scheme === "sftp" && known[where] !== t.trust) {
			known[where] = t.trust;
			writeConf("known_hosts.json", known);
		}
		var home = "/";
		for (var i = 0; i < lines.length; i++) {
			if (lines[i][0] === "path" && lines[i][1]) {
				home = lines[i][1];
			}
		}
		nets[++netCount] = t;
		log("site opened: " + site.scheme + "://" + where);
		future.result = {returnValue: true, ok: true, id: netCount, home: home};
	});
	return future;
};

// {id}: the site is no longer needed.
var netCloseAssistant = function() {};
netCloseAssistant.prototype.run = function(future) {
	var id = (this.controller.args || {}).id;
	if (nets[id] && nets[id].conn) {
		nets[id].conn.quit();
	}
	delete nets[id];
	future.result = {returnValue: true, ok: true};
	return future;
};

// {id, path} -> {entries}: a folder on the site, shaped like list's.
var netListAssistant = function() {};
netListAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = nets[args.id];
	var path = cleanNetPath(isNetPath(args.path) ? netPathOf(args.path) : args.path);
	if (!site || !path) {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	siteList(site, path, function(err, entries) {
		if (err) {
			return fail(future, err);
		}
		future.result = {returnValue: true, ok: true, entries: entries};
	});
	return future;
};

// {id, path, name} -> {path}: a new name on the site.
var netRenameAssistant = function() {};
netRenameAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = nets[args.id];
	var path = cleanNetPath(isNetPath(args.path) ? netPathOf(args.path) : args.path);
	var name = String(args.name || "").replace(/^\s+|\s+$/g, "");
	if (!site || !path || path === "/") {
		return fail(future, "That cannot be renamed.");
	}
	var bad = badName(name, "");
	if (bad) {
		return fail(future, bad);
	}
	var to = netJoin(parentOf(path), name);
	siteRename(site, path, to, function(err) {
		if (err) {
			return fail(future, err);
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
	var path = cleanNetPath(isNetPath(args.path) ? netPathOf(args.path) : args.path);
	var name = String(args.name || "").replace(/^\s+|\s+$/g, "");
	if (!site || !path) {
		return fail(future, "Folders cannot be made here.");
	}
	var bad = badName(name, "");
	if (bad) {
		return fail(future, bad);
	}
	var made = netJoin(path, name);
	siteMkdir(site, made, function(err, already) {
		if (err) {
			return fail(future, already ? "There is already something named \"" + name + "\" here." : err);
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
			var before = job.doneBytes;
			siteGet(site, remote, target, function(n) {
				job.doneBytes = before + n;
			}, function(err) {
				job.doneThings++;
				var st = stat(target);
				job.doneBytes = before + (st ? st.size : 0);
				if (err && !job.cancelled) {
					try { fs.unlinkSync(target); } catch (e1) {}
					jobError(remote, err);
				} else if (err) {
					try { fs.unlinkSync(target); } catch (e3) {}
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
		siteList(site, remote, function(err, entries) {
			if (err) {
				jobError(remote, err);
				next();
				return;
			}
			var inner = [];
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				netDownSteps(inner, site, netJoin(remote, e.n), join(dir, e.n), !!e.d, e.s);
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
			var before = job.doneBytes;
			sitePut(site, from, remote, function(n) {
				job.doneBytes = before + n;
			}, function(err) {
				job.doneThings++;
				job.doneBytes = before + (st.isFile() ? st.size : 0);
				if (err && !job.cancelled) {
					jobError(from, err);
				}
				next();
			});
			return;
		}
		job.doneThings++;
		// The folder is made if it is not there (a failure to make it because
		// it is already there is fine: it is merged, like a local copy).
		siteMkdir(site, remote, function() {
			siteList(site, remote, function(err, entries) {
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
						netUpSteps(inner, site, join(from, names[k]), netJoin(remote, toName), s2);
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
		// A folder in Google Drive goes to its trash whole, and WebDAV deletes a
		// folder with everything in it.
		if (!isDir || site.kind === "gdrive" || site.kind === "dav") {
			siteRemove(site, remote, false, function(err) {
				job.doneThings++;
				if (err && !job.cancelled) {
					jobError(remote, err);
				}
				next();
			});
			return;
		}
		siteList(site, remote, function(err, entries) {
			if (err) {
				jobError(remote, err);
				next();
				return;
			}
			var inner = [];
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				netDeleteSteps(inner, site, netJoin(remote, e.n), !!e.d);
			}
			// The folder itself goes once it is empty.
			inner.push(function(next2) {
				siteRemove(site, remote, true, function(err2) {
					job.doneThings++;
					if (err2 && !job.cancelled) {
						jobError(remote, err2);
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
function startNet(future, args, op, then) {
	var shared = nets[args.net];
	if (!shared) {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	var paths = args.paths || [];
	var i;
	var items = [];
	var down = paths.length > 0 && isNetPath(paths[0]);
	var upath = "";

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
				return fail(future, "Things from the site and from this " + DEVICE + " cannot go in one job.");
			}
			var rp = cleanNetPath(netPathOf(paths[i]));
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
		upath = isNetPath(updest) ? cleanNetPath(netPathOf(updest)) : null;
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

	var site = jobSite(shared);
	job = {
		id: ++jobCount, op: op, finished: false, cancelled: false, stage: "counting",
		bytes: 0, doneBytes: 0, things: 0, doneThings: 0, items: items.length, doneItems: 0, current: "",
		failed: 0, firstError: "", sizes: {}, started: new Date().getTime()
	};
	if (site.conn) {
		// Cancel ends the transfer under way; the job's connection goes with the job.
		job.kill = function() {
			site.conn.kill();
		};
		job.close = function() {
			site.conn.quit();
		};
	}
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
				siteList(site, group.path, function(err, entries) {
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
			siteList(site, upath, function(err, entries) {
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
				// The name is settled by the step above, so it is read when this runs.
				steps.push(function(next) {
					netUpSteps(job.steps, site, it.local, netJoin(it.to, it.toName || nameOf(it.local)), it.st);
					// netUpSteps added its step at the end; bring it to the front.
					job.steps.unshift(job.steps.pop());
					next();
				});
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
		runSteps(steps, then ? phaseEnd(then) : finish);
	}, 10);
	future.result = {returnValue: true, ok: true, id: job.id};
	return future;
}

// ---- Google Drive, signed in through Atlas -------------------------------------
//
// There is no Google sign-in this old system can show, so Drive uses the one
// the Atlas browser holds: its cookies for google.com, read from its cookie
// store on this TouchPad each time Drive is opened (so they stay as fresh as
// Atlas keeps them). With them, Drive's own web interface API
// (clients6.google.com/drive/v2internal, the one drive.google.com calls) is
// used the way the page uses it: the cookies, plus a SAPISIDHASH header made
// from one of them, plus the page's public API key, read from the page. Files
// come down from drive.usercontent.google.com. All of it goes through the
// system's curl, which speaks modern TLS; the cookies go to curl on its input,
// never on its command line.
//
// Drive knows things by id, not by path, and lets two things in a folder have
// one name; the paths shown here are made from the names, a second one of a
// name getting a number, and the ids are kept as folders are listed.
// Google Docs, Sheets, Slides and Drawings have no file of their own: they
// come down as .docx, .xlsx, .pptx and .pdf, and cannot be written back.
//
// Accounts: the "Google Drive" account template (service/account) is put
// where the accounts service reads templates the first time this service
// starts; its sign-in page is the app itself (driveCheck).

var ATLAS_COOKIES = "/var/atlas252/webkit-data/cookies.db";
var SQLITE = "/usr/bin/sqlite3";
var DRIVE_API = "https://clients6.google.com/drive/v2internal";
var DRIVE_UPLOAD = "https://clients6.google.com/upload/drive/v2internal";
var DRIVE_ORIGIN = "https://drive.google.com";
var DRIVE_UA = "Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var DRIVE_FOLDER = "application/vnd.google-apps.folder";
var DRIVE_TEMPLATE = "com.palm.stark.files.gdrive";
// Google's own kinds of file: how each comes down, and as what.
var DRIVE_EXPORTS = {
	"application/vnd.google-apps.document": {ext: ".docx", url: "https://docs.google.com/document/d/%s/export?format=docx"},
	"application/vnd.google-apps.spreadsheet": {ext: ".xlsx", url: "https://docs.google.com/spreadsheets/d/%s/export?format=xlsx"},
	"application/vnd.google-apps.presentation": {ext: ".pptx", url: "https://docs.google.com/presentation/d/%s/export/pptx"},
	"application/vnd.google-apps.drawing": {ext: ".pdf", url: "https://docs.google.com/drawings/d/%s/export/pdf"}
};

// Put the account template where the accounts service looks, when it is not
// there or has changed, and have the service read the templates again.
(function() {
	var from = "/media/cryptofs/apps/usr/palm/services/com.palm.stark.files.service/account";
	var to = "/media/cryptofs/apps/usr/palm/accounts/" + DRIVE_TEMPLATE;
	if (LUNEOS) {
		return;
	}
	try {
		var want = fs.readFileSync(from + "/" + DRIVE_TEMPLATE + ".json", "utf8");
		var have = "";
		try {
			have = fs.readFileSync(to + "/" + DRIVE_TEMPLATE + ".json", "utf8");
		} catch (e1) {}
		if (want === have) {
			return;
		}
		var sh = "mkdir -p '" + to + "/images' && cp -f '" + from + "/" + DRIVE_TEMPLATE + ".json' '" + to + "/' && " +
			"cp -f '" + from + "/images/'* '" + to + "/images/' && sync && " +
			"luna-send -n 1 palm://com.palm.service.accounts/__quit '{}' </dev/null >/dev/null 2>&1";
		child_process.spawn("/bin/sh", ["-c", sh]);
		log("put the Google Drive account template in place");
	} catch (e) {
		log("no Google Drive account template: " + e);
	}
})();

// Atlas's Google cookies: done(error, {cookie, sapisid}).
function atlasCookies(done) {
	var out = "";
	var sql = "select name, value from moz_cookies where host in ('.google.com', 'google.com', 'drive.google.com', '.drive.google.com');";
	var child;
	if (!exists(ATLAS_COOKIES) || !exists(SQLITE)) {
		done("Atlas was not found on this " + DEVICE + ". Install Atlas and sign in to Google there.");
		return;
	}
	try {
		child = child_process.spawn(SQLITE, ["-separator", "\t", ATLAS_COOKIES, sql]);
	} catch (e) {
		done("Atlas's sign-in could not be read.");
		return;
	}
	child.stdout.on("data", function(d) {
		out += d.toString();
	});
	child.on("exit", function(code) {
		var lines = out.split("\n");
		var parts = [];
		var seen = {};
		var sapisid = "";
		for (var i = 0; i < lines.length; i++) {
			var at = lines[i].indexOf("\t");
			if (at <= 0) {
				continue;
			}
			var name = lines[i].substring(0, at);
			var value = lines[i].substring(at + 1).replace(/[\r\n]/g, "");
			if (seen[name]) {
				continue;
			}
			seen[name] = true;
			parts.push(name + "=" + value);
			if (name === "SAPISID") {
				sapisid = value;
			}
		}
		if (code !== 0 || !seen.SID || !sapisid) {
			done("Atlas is not signed in to Google. Open Atlas, sign in at drive.google.com, then try again.");
			return;
		}
		done("", {cookie: parts.join("; "), sapisid: sapisid});
	});
}

// Run curl for Drive. headers: true sends the API's sign-in as well as the
// cookies. done(httpCode, body, errorText).
function driveCurl(site, args, done, headers) {
	var out = [];
	var err = "";
	var child;
	try {
		child = child_process.spawn(CURL, ["-K", "-", "--silent", "--show-error", "--connect-timeout", String(NET_CONNECT),
			// No "Expect: 100-continue": Google's interim answer would read as the result.
			"-A", DRIVE_UA, "-H", "Expect:", "-w", "\n%{http_code}"].concat(args), {cwd: "/"});
	} catch (e) {
		setTimeout(function() {
			done(0, "", String(e));
		}, 0);
		return;
	}
	if (job && !job.finished) {
		job.kids = job.kids || [];
		job.kids.push(child);
	}
	child.stdout.on("data", function(d) {
		out.push(d.toString());
	});
	child.stderr.on("data", function(d) {
		err += d.toString();
	});
	child.on("exit", function() {
		if (job && job.kids) {
			var at = job.kids.indexOf(child);
			if (at >= 0) {
				job.kids.splice(at, 1);
			}
		}
		var text = out.join("");
		var cut = text.lastIndexOf("\n");
		done(Number(text.substring(cut + 1)) || 0, text.substring(0, cut), err);
	});
	function quoted(s) {
		return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n]/g, " ");
	}
	var conf = "header = \"Cookie: " + quoted(site.cookie) + "\"\n";
	if (headers) {
		var ts = Math.floor(new Date().getTime() / 1000);
		var hash = require("crypto").createHash("sha1").update(ts + " " + site.sapisid + " " + DRIVE_ORIGIN).digest("hex");
		conf += "header = \"Authorization: SAPISIDHASH " + ts + "_" + hash + "\"\n" +
			"header = \"X-Origin: " + DRIVE_ORIGIN + "\"\n" +
			"header = \"X-Goog-AuthUser: 0\"\n";
	}
	try {
		child.stdin.write(conf);
		child.stdin.end();
	} catch (e2) {}
}

// A call to the API: done(error, parsed answer).
function driveApi(site, method, path, query, body, done) {
	var url = (path.indexOf("https://") === 0 ? path : DRIVE_API + path) + (path.indexOf("?") >= 0 ? "&" : "?") +
		(query ? query + "&" : "") + "key=" + site.key;
	var args = ["-X", method];
	if (body !== null && body !== undefined) {
		args.push("-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
	} else if (method !== "GET") {
		args.push("-d", "");
	}
	args.push(url);
	driveCurl(site, args, function(code, text, err) {
		var data = null;
		try {
			data = text ? JSON.parse(text) : {};
		} catch (e) {}
		if (code >= 200 && code < 300) {
			done("", data || {});
			return;
		}
		done(driveWhy(code, data, err), data);
	}, true);
}

function driveWhy(code, data, err) {
	var msg = data && data.error && data.error.message ? String(data.error.message) : "";
	if (code === 401 || code === 403 && /auth|sign/i.test(msg)) {
		return "Google wants you to sign in again: open Atlas, sign in at drive.google.com, then try again.";
	}
	if (code === 404) {
		return "That is not in Google Drive any more.";
	}
	if (code === 403) {
		return "Google Drive would not allow that" + (msg ? " (" + msg + ")" : "") + ".";
	}
	if (!code) {
		log("drive: curl failed: " + String(err || "").replace(/\s+/g, " ").substring(0, 200));
		return "Could not reach Google Drive.";
	}
	log("drive said " + code + ": " + (msg || err || "").substring(0, 200));
	return "Google Drive did not do what was asked" + (msg ? " (" + msg + ")" : "") + ".";
}

// Sign in: Atlas's cookies, the page's API key, and who the account is.
// done(error, site).
function driveOpen(done) {
	atlasCookies(function(err, ck) {
		if (err) {
			done(err);
			return;
		}
		var site = {kind: "gdrive", host: "drive", cookie: ck.cookie, sapisid: ck.sapisid, key: "", email: "",
			ids: {"/": {id: "root", d: 1}}};
		driveCurl(site, ["-L", DRIVE_ORIGIN + "/drive/my-drive"], function(code, page) {
			// The page carries more than one key; its own is the one it names most.
			var counts = {};
			var best = "";
			var re = /AIzaSy[A-Za-z0-9_\-]{33}/g;
			var m;
			while ((m = re.exec(page || "")) !== null) {
				counts[m[0]] = (counts[m[0]] || 0) + 1;
				if (!best || counts[m[0]] > counts[best]) {
					best = m[0];
				}
			}
			if (code !== 200 || !best) {
				done(code === 200 ? "Google Drive's page has changed; this needs an update of " + APP_NAME + "." :
					"Could not reach Google Drive.");
				return;
			}
			site.key = best;
			driveApi(site, "GET", "/about", "fields=user(emailAddress)", null, function(err2, about) {
				if (err2) {
					done(err2);
					return;
				}
				site.email = about.user && about.user.emailAddress || "";
				done("", site);
			});
		}, false);
	});
}

// {} -> {email}: whether Drive can be opened with Atlas's sign-in (the
// account's sign-in page asks this).
var driveCheckAssistant = function() {};
driveCheckAssistant.prototype.run = function(future) {
	driveOpen(function(err, site) {
		if (err) {
			return fail(future, err);
		}
		future.result = {returnValue: true, ok: true, email: site.email};
	});
	return future;
};

// {} -> {accounts: [{email}]}: the Google Drive accounts in Accounts.
var driveAccountsAssistant = function() {};
driveAccountsAssistant.prototype.run = function(future) {
	try {
		IMPORTS.foundations.Comms.PalmCall.call("palm://com.palm.service.accounts/", "listAccounts",
			{templateId: DRIVE_TEMPLATE}).then(function(f) {
				var list = [];
				try {
					var r = f.result || {};
					for (var i = 0; r.results && i < r.results.length; i++) {
						list.push({email: r.results[i].username || "", id: r.results[i]._id});
					}
				} catch (e) {}
				future.result = {returnValue: true, ok: true, accounts: list};
			});
	} catch (e) {
		future.result = {returnValue: true, ok: true, accounts: []};
	}
	return future;
};

// The display name of a Drive item: Google's own files get the ending they
// come down with, and a slash (allowed in Drive names) cannot be in a path.
function driveName(item) {
	var name = String(item.title || "Untitled").replace(/\//g, "_");
	var ex = DRIVE_EXPORTS[item.mimeType];
	if (ex && name.toLowerCase().lastIndexOf(ex.ext) !== name.length - ex.ext.length) {
		name += ex.ext;
	}
	return name;
}

// A folder's contents: done(error, entries), and the ids kept.
function driveList(site, path, done) {
	driveFind(site, path, function(err, folder) {
		if (err) {
			done(err, null);
			return;
		}
		if (!folder.d) {
			done("That is a file, not a folder.", null);
			return;
		}
		var entries = [];
		var taken = {};
		(function page(token) {
			var q = "q=" + encodeURIComponent("'" + folder.id + "' in parents and trashed=false") +
				"&maxResults=1000&fields=" + encodeURIComponent("nextPageToken,items(id,title,mimeType,fileSize,modifiedDate)") +
				(token ? "&pageToken=" + encodeURIComponent(token) : "");
			driveApi(site, "GET", "/files", q, null, function(err2, r) {
				if (err2) {
					done(err2, null);
					return;
				}
				var items = r.items || [];
				for (var i = 0; i < items.length; i++) {
					var it = items[i];
					if (it.mimeType === "application/vnd.google-apps.shortcut" || it.mimeType === "application/vnd.google-apps.form" ||
							it.mimeType === "application/vnd.google-apps.site" || it.mimeType === "application/vnd.google-apps.map") {
						continue;       // nothing here can show or bring these down
					}
					var dir = it.mimeType === DRIVE_FOLDER;
					var name = freeNetName(taken, driveName(it), dir);
					taken[name.toLowerCase()] = true;
					site.ids[netJoin(path, name)] = {id: it.id, d: dir ? 1 : 0, mime: it.mimeType};
					entries.push({n: name, d: dir ? 1 : 0, s: Number(it.fileSize) || 0,
						m: it.modifiedDate ? Date.parse(it.modifiedDate) || 0 : 0});
				}
				if (r.nextPageToken) {
					page(r.nextPageToken);
				} else {
					done("", entries);
				}
			});
		})("");
	});
}

// What is at a path: done(error, {id, d, mime}), listing the folders above it
// as needed.
function driveFind(site, path, done) {
	if (site.ids[path]) {
		done("", site.ids[path]);
		return;
	}
	if (path === "/") {
		done("", {id: "root", d: 1});
		return;
	}
	driveList(site, parentOf(path) || "/", function(err) {
		if (err) {
			done(err);
			return;
		}
		done(site.ids[path] ? "" : "That is not in Google Drive any more.", site.ids[path]);
	});
}

function driveGet(site, remote, local, done) {
	driveFind(site, remote, function(err, it) {
		if (err) {
			done(err);
			return;
		}
		if (it.d) {
			done("That is a folder.");
			return;
		}
		var ex = DRIVE_EXPORTS[it.mime];
		if (!ex && /^application\/vnd\.google-apps\./.test(it.mime || "")) {
			done("This kind of Google file cannot be brought down.");
			return;
		}
		var url = ex ? ex.url.replace("%s", it.id) :
			"https://drive.usercontent.google.com/download?id=" + encodeURIComponent(it.id) + "&export=download&authuser=0&confirm=t";
		driveCurl(site, ["-L", "-o", local, url], function(code) {
			// What comes back as a web page is a sign-in or a warning, not the file.
			if (code === 200 && it.mime !== "text/html" && looksLikePage(local)) {
				try { fs.unlinkSync(local); } catch (e) {}
				done("Google wants you to sign in again: open Atlas, sign in at drive.google.com, then try again.");
				return;
			}
			if (code !== 200) {
				try { fs.unlinkSync(local); } catch (e2) {}
				done(driveWhy(code, null, ""));
				return;
			}
			done("");
		}, false);
	});
}

// A file goes up: in place of one of that name in the folder, or as a new one.
function drivePut(site, local, remote, done) {
	var name = nameOf(remote);
	driveFind(site, parentOf(remote) || "/", function(err, folder) {
		if (err) {
			done(err);
			return;
		}
		var have = site.ids[remote];
		if (have && have.d) {
			done("A folder of that name is there.");
			return;
		}
		if (have && /^application\/vnd\.google-apps\./.test(have.mime || "")) {
			done("Google's own documents cannot be replaced from here.");
			return;
		}
		var url = DRIVE_UPLOAD + "/files" + (have ? "/" + encodeURIComponent(have.id) : "") +
			"?uploadType=media&fields=id&key=" + site.key;
		driveCurl(site, ["-X", have ? "PUT" : "POST", "-H", "Content-Type: application/octet-stream", "-T", local, url],
			function(code, text) {
				var r = null;
				try { r = JSON.parse(text); } catch (e) {}
				if (code < 200 || code >= 300 || !r || !r.id) {
					done(driveWhy(code, r, ""));
					return;
				}
				if (have) {
					done("");
					return;
				}
				// A new file starts out as "Untitled" in My Drive: name it and put it in place.
				var q = "fields=id" + (folder.id !== "root" ? "&addParents=" + encodeURIComponent(folder.id) + "&removeParents=root" : "");
				driveApi(site, "PATCH", "/files/" + encodeURIComponent(r.id), q, {title: name}, function(err2) {
					if (!err2) {
						site.ids[remote] = {id: r.id, d: 0, mime: ""};
					}
					done(err2);
				});
			}, true);
	});
}

// Whether a file that came down starts like a web page.
function looksLikePage(path) {
	var fd = null;
	try {
		fd = fs.openSync(path, "r");
		var b = new Buffer(256);
		var n = fs.readSync(fd, b, 0, 256, 0);
		fs.closeSync(fd);
		return /^\s*<(!doctype html|html)/i.test(b.toString("utf8", 0, n));
	} catch (e) {
		try { fs.closeSync(fd); } catch (e2) {}
		return false;
	}
}

function driveMkdir(site, path, done) {
	driveFind(site, parentOf(path) || "/", function(err, folder) {
		if (err) {
			done(err, false);
			return;
		}
		if (site.ids[path]) {
			done("There is already something by that name there.", true);
			return;
		}
		driveApi(site, "POST", "/files", "fields=id", {title: nameOf(path), mimeType: DRIVE_FOLDER, parents: [{id: folder.id}]},
			function(err2, r) {
				if (!err2) {
					site.ids[path] = {id: r.id, d: 1, mime: DRIVE_FOLDER};
				}
				done(err2, false);
			});
	});
}

// A new name, or a new folder, or both.
function driveRename(site, from, to, done) {
	driveFind(site, from, function(err, it) {
		if (err) {
			done(err);
			return;
		}
		driveFind(site, parentOf(from) || "/", function(err2, oldParent) {
			driveFind(site, parentOf(to) || "/", function(err3, newParent) {
				if (err2 || err3) {
					done(err2 || err3);
					return;
				}
				var q = "fields=id";
				if (oldParent.id !== newParent.id) {
					q += "&addParents=" + encodeURIComponent(newParent.id) + "&removeParents=" + encodeURIComponent(oldParent.id);
				}
				// Google's own files keep their names without the ending shown here.
				var title = nameOf(to);
				var ex = DRIVE_EXPORTS[it.mime];
				if (ex && title.toLowerCase().lastIndexOf(ex.ext) === title.length - ex.ext.length) {
					title = title.substring(0, title.length - ex.ext.length);
				}
				driveApi(site, "PATCH", "/files/" + encodeURIComponent(it.id), q, {title: title}, function(err4) {
					if (!err4) {
						delete site.ids[from];
						site.ids[to] = it;
					}
					done(err4);
				});
			});
		});
	});
}

// Into Drive's trash, where it can still be got back from drive.google.com.
function driveTrash(site, path, done) {
	driveFind(site, path, function(err, it) {
		if (err) {
			done(err);
			return;
		}
		driveApi(site, "POST", "/files/" + encodeURIComponent(it.id) + "/trash", "fields=id", null, function(err2) {
			if (!err2) {
				delete site.ids[path];
			}
			done(err2);
		});
	});
}

// ---- WebDAV: Nextcloud accounts, and davs:// addresses ----------------------
//
// A Nextcloud account in Accounts (made by the Nextcloud app, template
// com.stark.nextcloud) is opened as nextcloud://<account id>/: its server,
// user and app password are read from Accounts, which lets this service read
// them because the template names it in readPermissions. Any other WebDAV
// server can be typed as davs://user@host/path (or dav:// without TLS).
//
// Everything goes through the system's curl, one request per operation, with
// the sign-in on curl's input: PROPFIND to list, GET and PUT to move files,
// MKCOL, MOVE and DELETE (which takes a folder with everything in it).

var NC_TEMPLATE = "com.stark.nextcloud";

// The Nextcloud accounts in Accounts: done([{id, name}]).
function nextcloudAccounts(done) {
	try {
		IMPORTS.foundations.Comms.PalmCall.call("palm://com.palm.service.accounts/", "listAccounts",
			{templateId: NC_TEMPLATE}).then(function(f) {
				var list = [];
				try {
					var r = f.result || {};
					for (var i = 0; r.results && i < r.results.length; i++) {
						list.push({id: r.results[i]._id, name: r.results[i].username || "Nextcloud"});
					}
				} catch (e) {}
				done(list);
			});
	} catch (e) {
		done([]);
	}
}

// {} -> {accounts: [{id, name}]}
var nextcloudAccountsAssistant = function() {};
nextcloudAccountsAssistant.prototype.run = function(future) {
	nextcloudAccounts(function(list) {
		future.result = {returnValue: true, ok: true, accounts: list};
	});
	return future;
};

// A Nextcloud account's sign-in, from Accounts: done(error, {url, user, userId, password}).
function nextcloudCredentials(accountId, done) {
	try {
		IMPORTS.foundations.Comms.PalmCall.call("palm://com.palm.service.accounts/", "readCredentials",
			{accountId: accountId, name: "common"}).then(function(f) {
				var c = null;
				try {
					c = f.result && f.result.credentials;
				} catch (e) {}
				if (!c || !c.url || !c.password) {
					done("The Nextcloud account's sign-in could not be read. Open the Nextcloud app and sign in again.");
					return;
				}
				done("", c);
			});
	} catch (e) {
		done("The Nextcloud account's sign-in could not be read.");
	}
}

function davCurl(site, args, done) {
	var out = [];
	var err = "";
	var child;
	try {
		child = child_process.spawn(CURL, ["-K", "-", "--silent", "--show-error", "--connect-timeout", String(NET_CONNECT),
			"-H", "Expect:", "-w", "\n%{http_code}"].concat(args), {cwd: "/"});
	} catch (e) {
		setTimeout(function() {
			done(0, "", String(e));
		}, 0);
		return;
	}
	if (job && !job.finished) {
		job.kids = job.kids || [];
		job.kids.push(child);
	}
	child.stdout.on("data", function(d) {
		out.push(d.toString());
	});
	child.stderr.on("data", function(d) {
		err += d.toString();
	});
	child.on("exit", function() {
		if (job && job.kids) {
			var at = job.kids.indexOf(child);
			if (at >= 0) {
				job.kids.splice(at, 1);
			}
		}
		var text = out.join("");
		var cut = text.lastIndexOf("\n");
		done(Number(text.substring(cut + 1)) || 0, text.substring(0, cut), err);
	});
	function quoted(s) {
		return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n]/g, " ");
	}
	try {
		child.stdin.write("user = \"" + quoted(site.user) + ":" + quoted(site.pass) + "\"\n");
		child.stdin.end();
	} catch (e2) {}
}

// The URL of something on the server: each part of the path encoded.
function davUrl(site, path, folder) {
	var enc = [];
	var parts = String(path || "/").split("/");
	for (var i = 0; i < parts.length; i++) {
		if (parts[i]) {
			enc.push(encodeURIComponent(parts[i]));
		}
	}
	var url = site.base + enc.join("/");
	return folder && enc.length ? url + "/" : url;
}

function davWhy(code, err) {
	if (code === 401) {
		return "The server refused the name or password.";
	}
	if (code === 403) {
		return "The server would not allow that.";
	}
	if (code === 404 || code === 409) {
		return "That is not on the server, or the server would not show it.";
	}
	if (code === 507) {
		return "The server is out of space.";
	}
	if (!code) {
		log("dav: curl failed: " + String(err || "").replace(/\s+/g, " ").substring(0, 200));
		return "Could not reach the server.";
	}
	log("dav said " + code);
	return "The server did not do what was asked (" + code + ").";
}

function xmlText(s) {
	return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
		.replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

function davList(site, path, done) {
	var body = "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/>" +
		"<d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>";
	var url = davUrl(site, path, true);
	davCurl(site, ["-X", "PROPFIND", "-H", "Depth: 1", "-H", "Content-Type: application/xml; charset=utf-8",
		"--data-binary", body, url], function(code, text, err) {
		if (code !== 207) {
			done(davWhy(code, err), null);
			return;
		}
		// The folder itself comes back as one of the answers: known by its path.
		var self = url.replace(/^https?:\/\/[^\/]+/i, "").replace(/\/+$/, "");
		try {
			self = decodeURIComponent(self);
		} catch (e0) {}
		var blocks = text.split(/<(?:[A-Za-z0-9_\-]+:)?response[\s>]/).slice(1);
		var entries = [];
		for (var i = 0; i < blocks.length; i++) {
			var b = blocks[i];
			var href = /<(?:[A-Za-z0-9_\-]+:)?href>([^<]*)</.exec(b);
			if (!href) {
				continue;
			}
			var p = xmlText(href[1]).replace(/^https?:\/\/[^\/]+/i, "").replace(/\/+$/, "");
			try {
				p = decodeURIComponent(p);
			} catch (e1) {}
			if (p === self || !p) {
				continue;
			}
			var name = p.substring(p.lastIndexOf("/") + 1);
			var dir = /<(?:[A-Za-z0-9_\-]+:)?collection\s*\/?>/.test(b);
			var len = /<(?:[A-Za-z0-9_\-]+:)?getcontentlength[^>]*>(\d+)</.exec(b);
			var mod = /<(?:[A-Za-z0-9_\-]+:)?getlastmodified[^>]*>([^<]+)</.exec(b);
			entries.push({n: name, d: dir ? 1 : 0, s: len ? Number(len[1]) : 0, m: mod ? Date.parse(mod[1]) || 0 : 0});
		}
		done("", entries);
	});
}

function davGet(site, remote, local, done) {
	davCurl(site, ["-o", local, davUrl(site, remote, false)], function(code, text, err) {
		if (code !== 200) {
			try { fs.unlinkSync(local); } catch (e) {}
			done(davWhy(code, err));
			return;
		}
		done("");
	});
}

function davPut(site, local, remote, done) {
	davCurl(site, ["-T", local, davUrl(site, remote, false)], function(code, text, err) {
		done(code === 200 || code === 201 || code === 204 ? "" : davWhy(code, err));
	});
}

// done(error, already)
function davMkdir(site, path, done) {
	davCurl(site, ["-X", "MKCOL", davUrl(site, path, true)], function(code, text, err) {
		if (code === 201) {
			done("", false);
		} else {
			done(code === 405 ? "There is already something by that name there." : davWhy(code, err), code === 405);
		}
	});
}

function davMove(site, from, to, done) {
	davCurl(site, ["-X", "MOVE", "-H", "Destination: " + davUrl(site, to, false), "-H", "Overwrite: F",
		davUrl(site, from, false)], function(code, text, err) {
		if (code === 201 || code === 204) {
			done("");
		} else {
			done(code === 412 ? "There is already something by that name there." : davWhy(code, err));
		}
	});
}

// A file, or a folder with everything in it.
function davDelete(site, path, done) {
	davCurl(site, ["-X", "DELETE", davUrl(site, path, false)], function(code, text, err) {
		done(code === 200 || code === 204 ? "" : davWhy(code, err));
	});
}

// Open nextcloud://<account id>/ or davs://user:pass@host/: done(error, site, login).
function davOpen(parts, done) {
	function check(site, start) {
		davCurl(site, ["-X", "PROPFIND", "-H", "Depth: 0", davUrl(site, start || "/", true)], function(code, text, err) {
			if (code === 207) {
				done("", site);
			} else if (code === 401) {
				done(davWhy(code, err), null, true);
			} else {
				done(davWhy(code, err), null);
			}
		});
	}
	if (parts.scheme === "nextcloud") {
		nextcloudCredentials(parts.host, function(err, c) {
			if (err) {
				done(err, null);
				return;
			}
			var url = String(c.url).replace(/\/+$/, "");
			check({kind: "dav", host: "nextcloud-" + parts.host,
				base: url + "/remote.php/dav/files/" + encodeURIComponent(c.userId || c.user) + "/",
				user: c.user, pass: c.password});
		});
		return;
	}
	var tls = parts.scheme === "davs";
	// The server's top is the site's top, as for FTP; the address's path is
	// where the app starts, and is what the sign-in is tried on.
	check({kind: "dav", host: parts.host + (parts.port ? "-" + parts.port : ""),
		base: (tls ? "https://" : "http://") + parts.host + (parts.port ? ":" + parts.port : "") + "/",
		user: parts.user, pass: parts.pass}, cleanNetPath(parts.start || "/"));
}

// ---- work through the TouchPad: between sites, archives on a site, opening ----
//
// Some things cannot be done on a server itself: copying from one server to
// another, making or unpacking an archive there, and opening a file that is
// there. They are done in stages through a folder on the storage: things come
// down, are worked on, go up, and the folder is emptied again. Each stage is
// an ordinary job (startNet, startArchive) whose end hands on to the next
// stage instead of finishing, so the app follows one job from start to end.

var WORK_DIR = ROOT + "/.topaz-explorer";
var STAGE_DIR = WORK_DIR + "/staging";
var CACHE_DIR = WORK_DIR + "/cache";
var KEEP_MS = 2 * 86400000;   // how long a file opened from a site is kept
var SEARCH_FOLDERS = 2000;    // folders looked through on a site at most
var SEARCH_MS = 60000;        // and for how long

// Make a folder and those above it. True when it is there.
function mkdirs(path) {
	var parts = path.split("/");
	var at = "";
	for (var i = 0; i < parts.length; i++) {
		if (!parts[i]) {
			continue;
		}
		at += "/" + parts[i];
		try {
			fs.mkdirSync(at, 493 /* 0755 */);
		} catch (e) {}
	}
	var st = stat(path);
	return !!st && st.isDirectory();
}

// Take away what is in a folder and older than ms, the folder kept.
function dropOld(dir, ms) {
	var names = [];
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		return;
	}
	var now = new Date().getTime();
	for (var i = 0; i < names.length; i++) {
		var p = join(dir, names[i]);
		var st = stat(p);
		if (st && now - st.mtime.getTime() > ms) {
			removeAll(p, st, false);
		} else if (st && st.isDirectory()) {
			dropOld(p, ms);
		}
	}
}

// A new empty folder to work in, or null. What an earlier run left behind
// (the app or service stopped part way) goes.
function newStage() {
	dropOld(STAGE_DIR, 3600000);
	var dir = STAGE_DIR + "/" + new Date().getTime();
	return mkdirs(dir) ? dir : null;
}

function dropStage(dir) {
	var st = stat(dir);
	if (st) {
		removeAll(dir, st, false);
	}
}

// The things in a folder, as full paths.
function contentsOf(dir) {
	var out = [];
	try {
		var names = fs.readdirSync(dir);
		for (var i = 0; i < names.length; i++) {
			out.push(join(dir, names[i]));
		}
	} catch (e) {}
	return out;
}

// What runs when a stage's steps are done: tidy the stage, then go on.
function phaseEnd(then) {
	return function() {
		if (job.sizeWatch) {
			clearInterval(job.sizeWatch);
			job.sizeWatch = null;
		}
		if (job.close) {
			job.close();
			job.close = null;
		}
		then();
	};
}

// Run stages one after another. A stage is function(future, then, chain): it
// starts a job that calls then() at its end, or fails into future, or calls
// then() at once when it has nothing to do. Things that could not be done are
// added up over the stages; a cancel, a failed archive or a wanted password
// stops the rest. tidy() runs at the end in any case. The first stage's start
// answers the app.
function runStages(future, stages, tidy) {
	var at = 0;
	var chain = {failed: 0, firstError: ""};
	var counted = null;
	var over = false;
	function end() {
		if (over) {
			return;
		}
		over = true;
		try {
			tidy();
		} catch (e) {
			log("tidy: " + e);
		}
		job.failed = chain.failed;
		job.firstError = chain.firstError;
		finish();
	}
	function next() {
		if (at > 0 && job && job !== counted) {
			counted = job;
			chain.failed += job.failed;
			chain.firstError = chain.firstError || job.firstError;
		}
		if (at > 0 && (job.cancelled || job.note || job.password)) {
			end();
			return;
		}
		if (at >= stages.length) {
			end();
			return;
		}
		var f = {};
		stages[at++](f, next, chain);
		if (f.result && f.result.ok === false) {
			if (at === 1) {
				// Nothing began: the app is told so, as for any job.
				over = true;
				try { tidy(); } catch (e2) {}
				future.result = f.result;
				return;
			}
			job.note = f.result.error;
			end();
		}
	}
	next();
	if (!future.result) {
		future.result = {returnValue: true, ok: true, id: job.id};
	}
	return future;
}

// {op: copy|move, net: from, toNet: to, paths, dest}: from one site to
// another, or to another folder of the same one. A move within one site is a
// rename; anything else comes down and goes up again, and a move takes the
// originals away only when every part arrived.
function startRelay(future, args, op) {
	var from = nets[args.net];
	var to = nets[args.toNet];
	var dest = String(args.dest || "");
	if (!from || !to) {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	var destPath = isNetPath(dest) ? cleanNetPath(netPathOf(dest)) : null;
	if (!destPath) {
		return fail(future, "That folder is not on a site.");
	}
	var paths = args.paths || [];
	for (var i = 0; i < paths.length; i++) {
		var rp = isNetPath(paths[i]) ? cleanNetPath(netPathOf(paths[i])) : null;
		if (!rp || rp === "/") {
			return fail(future, "That cannot be copied from the site.");
		}
		if (args.net === args.toNet) {
			if (destPath === rp || destPath.indexOf(rp + "/") === 0) {
				return fail(future, "\"" + nameOf(rp) + "\" cannot be put inside itself.");
			}
			if (op === "move" && parentOf(rp) === destPath) {
				return fail(future, "Those are already in this folder.");
			}
		}
	}
	if (args.net === args.toNet && op === "move") {
		return moveOnSite(future, from, paths, destPath);
	}
	var stage = newStage();
	if (!stage) {
		return fail(future, "No room to work in on the " + DEVICE + "'s storage.");
	}
	var stages = [
		function(f, then) {
			startNet(f, {net: args.net, paths: paths, dest: stage}, "copy", then);
		},
		function(f, then) {
			var got = contentsOf(stage);
			if (!got.length) {
				then();
				return;
			}
			startNet(f, {net: args.toNet, paths: got, dest: dest}, "copy", then);
		}
	];
	if (op === "move") {
		stages.push(function(f, then, chain) {
			if (chain.failed) {
				then();
				return;
			}
			startNet(f, {net: args.net, paths: paths}, "delete", then);
		});
	}
	log(op + " between sites: " + paths.length + " item(s)");
	return runStages(future, stages, function() {
		dropStage(stage);
	});
}

// A move from one folder of a site to another: each thing is renamed into
// place, with a name of its own if one is taken there.
function moveOnSite(future, site, paths, destPath) {
	job = {
		id: ++jobCount, op: "move", finished: false, cancelled: false, stage: "working",
		bytes: 0, doneBytes: 0, things: paths.length, doneThings: 0, items: paths.length, doneItems: 0,
		current: "", failed: 0, firstError: "", sizes: {}, started: new Date().getTime()
	};
	stayAwake();
	var steps = [];
	job.steps = steps;
	var taken = {};
	steps.push(function(next) {
		siteList(site, destPath, function(err, entries) {
			for (var i = 0; !err && i < entries.length; i++) {
				taken[entries[i].n.toLowerCase()] = true;
			}
			next();
		});
	});
	for (var i = 0; i < paths.length; i++) {
		(function(rp) {
			steps.push(function(next) {
				job.current = nameOf(rp);
				var name = freeNetName(taken, nameOf(rp), false);
				taken[name.toLowerCase()] = true;
				siteRename(site, rp, netJoin(destPath, name), function(err) {
					job.doneThings++;
					job.doneItems++;
					if (err && !job.cancelled) {
						jobError(rp, err);
					}
					next();
				});
			});
		})(cleanNetPath(netPathOf(paths[i])));
	}
	setTimeout(function() {
		runSteps(steps, finish);
	}, 10);
	future.result = {returnValue: true, ok: true, id: job.id};
	return future;
}

// {op: pack, net, paths, dest, name} and {op: extract, net, paths: [archive],
// dest, folder, password}: archives made or unpacked on a site, by way of
// the TouchPad. What is made goes up beside what it came from; a name in use
// there gets a number.
function startNetArchive(future, args, op) {
	var site = nets[args.net];
	if (!site) {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	var dest = String(args.dest || "");
	if (!isNetPath(dest)) {
		return fail(future, "That folder is not on the site being shown.");
	}
	var name = String(args.name || "").replace(/^\s+|\s+$/g, "");
	if (op === "pack") {
		if (!/\.(zip|7z|tar)$/i.test(name)) {
			name += ".zip";
		}
		var bad = badName(name, "");
		if (bad) {
			return fail(future, bad);
		}
	}
	var stage = newStage();
	if (!stage || !mkdirs(stage + "/in") || !mkdirs(stage + "/out")) {
		return fail(future, "No room to work in on the " + DEVICE + "'s storage.");
	}
	var down = stage + "/in";
	var out = stage + "/out";
	var stages = [
		function(f, then) {
			startNet(f, {net: args.net, paths: args.paths || [], dest: down}, "copy", then);
		},
		function(f, then) {
			var got = contentsOf(down);
			if (!got.length) {
				then();
				return;
			}
			if (op === "pack") {
				startArchive(f, {paths: got, dest: out, name: name}, "pack", then);
			} else {
				startArchive(f, {paths: got, dest: out, folder: args.folder, password: args.password}, "extract", then);
			}
		},
		function(f, then) {
			var made = contentsOf(out);
			if (!made.length) {
				then();
				return;
			}
			startNet(f, {net: args.net, paths: made, dest: dest}, "copy", then);
		}
	];
	log(op + " on a site: " + (args.paths || []).length + " item(s)");
	return runStages(future, stages, function() {
		dropStage(stage);
	});
}

// Where a file from a site is kept to be opened: the site and its path,
// with what the storage cannot have in a name made plain.
function cachePath(site, remote) {
	var host = String(site.base || (site.kind + "-" + site.host + (site.port ? "-" + site.port : "")))
		.replace(/^[a-z]+:\/\//i, "").replace(/[\\\/:*?"<>|]+/g, "_");
	var parts = String(remote).split("/");
	var out = CACHE_DIR + "/" + host;
	for (var i = 0; i < parts.length; i++) {
		if (parts[i]) {
			out += "/" + parts[i].replace(/[\\:*?"<>|]/g, "_");
		}
	}
	return out;
}

// A copy kept from before can be used when it is recent and the same size.
function cachedCopy(local, size) {
	var st = stat(local);
	return !!st && st.isFile() && (size === undefined || size === null || st.size === Number(size)) &&
		new Date().getTime() - st.mtime.getTime() < KEEP_MS;
}

// {op: fetch, net, paths: [file], size} -> when done, result: where the copy
// is on the storage, to be opened from there.
function startFetch(future, args) {
	var site = nets[args.net];
	var url = (args.paths || [])[0];
	var remote = isNetPath(url) ? cleanNetPath(netPathOf(url)) : null;
	if (!site || !remote || remote === "/") {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	dropOld(CACHE_DIR, KEEP_MS);
	var local = cachePath(site, remote);
	var here = parentOf(local);
	if (!mkdirs(here)) {
		return fail(future, "No room to keep it on the " + DEVICE + "'s storage.");
	}
	var stages = [];
	if (cachedCopy(local, args.size)) {
		// Already here: a job that does nothing, so the app goes the same way.
		stages.push(function(f, then) {
			job = {
				id: ++jobCount, op: "copy", finished: false, cancelled: false, stage: "working",
				bytes: 0, doneBytes: 0, things: 1, doneThings: 1, items: 1, doneItems: 1, current: "",
				failed: 0, firstError: "", sizes: {}
			};
			setTimeout(then, 10);
		});
	} else {
		try { fs.unlinkSync(local); } catch (e) {}
		stages.push(function(f, then) {
			// The name it comes down as is the site's own (see netDownSteps).
			local = join(here, nameOf(remote));
			startNet(f, {net: args.net, paths: [url], dest: here}, "copy", then);
		});
	}
	return runStages(future, stages, function() {
		if (exists(local) && !job.cancelled) {
			job.result = local;
		}
	});
}

// {id, path, size} -> {path}: a file from the site, brought down to be
// shown (pictures, one after another), without the job's progress dialog.
var netGetAssistant = function() {};
netGetAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = nets[args.id];
	var remote = cleanNetPath(isNetPath(args.path) ? netPathOf(args.path) : args.path);
	if (!site || !remote || remote === "/") {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	var local = cachePath(site, remote);
	if (cachedCopy(local, args.size)) {
		future.result = {returnValue: true, ok: true, path: local};
		return future;
	}
	if (!mkdirs(parentOf(local))) {
		return fail(future, "No room to keep it on the " + DEVICE + "'s storage.");
	}
	var part = local + ".part";
	siteGet(site, remote, part, null, function(err) {
		if (err) {
			try { fs.unlinkSync(part); } catch (e) {}
			return fail(future, err);
		}
		try {
			try { fs.unlinkSync(local); } catch (e2) {}
			fs.renameSync(part, local);
		} catch (e3) {
			return fail(future, "It could not be kept on the " + DEVICE + whyNot(e3));
		}
		future.result = {returnValue: true, ok: true, path: local};
	});
	return future;
};

// {id, local, path}: a file on the storage goes up to the site in place of
// the one there (the text editor saving a file it opened from a site).
var netPutAssistant = function() {};
netPutAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = nets[args.id];
	var remote = cleanNetPath(isNetPath(args.path) ? netPathOf(args.path) : args.path);
	var local = clean(args.local);
	if (!site || !remote || remote === "/") {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	if (!local || !stat(local)) {
		return fail(future, "The file to send could not be found.");
	}
	sitePut(site, local, remote, null, function(err) {
		if (err) {
			return fail(future, err);
		}
		future.result = {returnValue: true, ok: true};
	});
	return future;
};

// {id, path, text, hidden} -> {entries: [{p: folder on the site, n, d, s, m}],
// more: true when cut short}: everything under a folder of the site whose
// name contains the text. A folder at a time, within limits, as each one is
// a request to the server.
var netSearchAssistant = function() {};
netSearchAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var site = nets[args.id];
	var top = cleanNetPath(isNetPath(args.path) ? netPathOf(args.path) : args.path);
	var text = String(args.text || "").toLowerCase();
	if (!site || !top) {
		return fail(future, "That site is no longer connected. Type its address again.");
	}
	if (!text) {
		return fail(future, "Type something to search for.");
	}
	var found = [];
	var queue = [top];
	var looked = 0;
	var began = new Date().getTime();
	(function next() {
		if (!queue.length || found.length >= MAX_FOUND || looked >= SEARCH_FOLDERS ||
				new Date().getTime() - began > SEARCH_MS) {
			future.result = {returnValue: true, ok: true, entries: found,
				more: queue.length > 0 || found.length >= MAX_FOUND};
			return;
		}
		var dir = queue.shift();
		looked++;
		siteList(site, dir, function(err, entries) {
			for (var i = 0; !err && i < entries.length && found.length < MAX_FOUND; i++) {
				var e = entries[i];
				if (!args.hidden && e.n.charAt(0) === ".") {
					continue;
				}
				if (e.n.toLowerCase().indexOf(text) >= 0) {
					found.push({p: dir, n: e.n, d: e.d, s: e.s, m: e.m});
				}
				if (e.d) {
					queue.push(netJoin(dir, e.n));
				}
			}
			next();
		});
	})();
	return future;
};

// ---- sharing this TouchPad over FTP ----------------------------------------------
//
// ftpd.js serves the storage. It runs as a process of its own, started through
// the shell so it is nobody's child, and outlives the app and this service; it
// leaves its number in a file so it can be found and stopped. The system's
// firewall lets nothing in, so while sharing, the control port and the passive
// data ports are let through, and shut again when sharing stops.

var FTPD = "/media/cryptofs/apps/usr/palm/services/com.palm.stark.files.service/ftpd.js";
var FTPD_PID = "/tmp/topaz-ftpd.pid";
var FTPD_STATUS = "/tmp/topaz-ftpd.json";
var FTPD_LOG = "/tmp/topaz-ftpd.log";
var PASV_FROM = 50100;
var PASV_TO = 50119;

// The sharing settings: {port, user, pass, readOnly}, with a password made up
// the first time.
function shareConf() {
	var c = readConf("ftp-share.json");
	var changed = false;
	if (!c.port) {
		c.port = 2121;
		changed = true;
	}
	if (!c.user) {
		c.user = DEVICE.toLowerCase().replace(/[^a-z0-9]/g, "") || "touchpad";
		changed = true;
	}
	if (!c.pass) {
		var letters = "abcdefghjkmnpqrstuvwxyz23456789";
		c.pass = "";
		for (var i = 0; i < 8; i++) {
			c.pass += letters.charAt(Math.floor(Math.random() * letters.length));
		}
		changed = true;
	}
	c.readOnly = !!c.readOnly;
	if (changed) {
		writeConf("ftp-share.json", c);
	}
	return c;
}

// The server's process number while it runs, else 0.
function ftpdPid() {
	try {
		var pid = parseInt(fs.readFileSync(FTPD_PID, "utf8"), 10);
		if (pid > 0 && fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").indexOf("ftpd.js") >= 0) {
			return pid;
		}
	} catch (e) {}
	return 0;
}

// Let the ports through the firewall (open) or take that away again. Each
// rule is removed first, so there is never more than one.
function shareFirewall(port, open, done) {
	var rules = [["--dport", String(port)], ["--dport", PASV_FROM + ":" + PASV_TO]];
	var script = "";
	for (var i = 0; i < rules.length; i++) {
		var r = "INPUT -p tcp " + rules[i].join(" ") + " -j ACCEPT";
		script += "while iptables -D " + r + " 2>/dev/null; do :; done\n";
		if (open) {
			script += "iptables -I " + r + "\n";
		}
	}
	if (LUNEOS) {
		done();
		return;
	}
	var sh = child_process.spawn("/bin/sh", ["-c", script]);
	sh.on("exit", function() {
		done();
	});
}

// This TouchPad's addresses on the network, from "ip addr" (or ifconfig).
function myAddresses(done) {
	var out = "";
	var sh = child_process.spawn("/bin/sh", ["-c", "ip -4 addr 2>/dev/null || ifconfig 2>/dev/null"]);
	sh.stdout.on("data", function(d) {
		out += d.toString();
	});
	sh.on("exit", function() {
		var found = [];
		var re = /inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)/g;
		var m;
		while ((m = re.exec(out)) !== null) {
			if (m[1].indexOf("127.") !== 0 && found.indexOf(m[1]) < 0) {
				found.push(m[1]);
			}
		}
		done(found);
	});
}

function shareStatus(future, extra) {
	var c = shareConf();
	var pid = ftpdPid();
	var st = {};
	try {
		st = JSON.parse(fs.readFileSync(FTPD_STATUS, "utf8"));
	} catch (e) {}
	myAddresses(function(addrs) {
		var r = {returnValue: true, ok: true, on: !!pid, port: c.port, user: c.user, pass: c.pass,
			readOnly: c.readOnly, addresses: addrs, clients: pid ? (st.clients || 0) : 0};
		for (var k in (extra || {})) {
			if (extra.hasOwnProperty(k)) {
				r[k] = extra[k];
			}
		}
		future.result = r;
	});
	return future;
}

// {} -> {on, port, user, pass, readOnly, addresses, clients}
var shareStatusAssistant = function() {};
shareStatusAssistant.prototype.run = function(future) {
	return shareStatus(future);
};

// {on, port, user, pass, readOnly} -> the same as shareStatus. Settings that
// are given are kept for next time; a running server is restarted with them.
var shareAssistant = function() {};
shareAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var c = shareConf();
	if (args.port !== undefined) {
		var port = parseInt(args.port, 10);
		if (!(port >= 1 && port <= 65535) || (port >= PASV_FROM && port <= PASV_TO)) {
			return fail(future, "Pick a port from 1 to 65535, outside " + PASV_FROM + "-" + PASV_TO + ".");
		}
		c.port = port;
	}
	if (args.user !== undefined) {
		var user = String(args.user).replace(/^\s+|\s+$/g, "");
		if (!user || /\s/.test(user)) {
			return fail(future, "The name cannot be empty or have spaces in it.");
		}
		c.user = user;
	}
	if (args.pass !== undefined) {
		if (String(args.pass).length < 4) {
			return fail(future, "Use a password of 4 letters or more.");
		}
		c.pass = String(args.pass);
	}
	if (args.readOnly !== undefined) {
		c.readOnly = !!args.readOnly;
	}
	writeConf("ftp-share.json", c);

	var pid = ftpdPid();
	var oldPort = readConf("ftp-share-running.json").port || c.port;
	function stopped(then) {
		if (!pid) {
			then();
			return;
		}
		try {
			process.kill(pid, "SIGTERM");
		} catch (e) {}
		// Wait for it to let go of its port.
		var waited = 0;
		(function check() {
			if (ftpdPid() && waited < 3000) {
				waited += 100;
				setTimeout(check, 100);
				return;
			}
			then();
		})();
	}
	stopped(function() {
		shareFirewall(oldPort, false, function() {
			if (!args.on) {
				log("sharing stopped");
				shareStatus(future);
				return;
			}
			// The server's settings, readable by root only.
			var file = confDir() + "/ftpd-run.json";
			try {
				fs.writeFileSync(file, JSON.stringify({root: ROOT, port: c.port, user: c.user, pass: c.pass,
					readOnly: c.readOnly, pasvFrom: PASV_FROM, pasvTo: PASV_TO,
					pidFile: FTPD_PID, statusFile: FTPD_STATUS}));
				fs.chmodSync(file, 384 /* 0600 */);
			} catch (e) {
				fail(future, "The sharing settings could not be written.");
				return;
			}
			try { fs.unlinkSync(FTPD_STATUS); } catch (e2) {}
			writeConf("ftp-share-running.json", {port: c.port});
			shareFirewall(c.port, true, function() {
				var q = function(s) {
					return "'" + String(s).replace(/'/g, "'\\''") + "'";
				};
				// Everything this service has open is closed first. The system
				// watches the pipes it gave the service to know when it has
				// ended; a server still holding one keeps the service "running"
				// after it has gone, and no new one is started, so the app waits
				// for it for ever. (ftpd.js also lets go of sockets itself.)
				child_process.spawn("/bin/sh", ["-c",
					"for f in /proc/$$/fd/*; do n=${f##*/}; [ \"$n\" -gt 2 ] 2>/dev/null && eval \"exec $n>&-\"; done; " +
					q(process.execPath) + " " + q(FTPD) + " " + q(file) + " >> " + FTPD_LOG + " 2>&1 </dev/null &"]);
				// Give it a moment to start listening, or to fail.
				var waited = 0;
				(function check() {
					var st = {};
					try {
						st = JSON.parse(fs.readFileSync(FTPD_STATUS, "utf8"));
					} catch (e3) {}
					if (st.error) {
						shareFirewall(c.port, false, function() {
							fail(future, st.error === "EADDRINUSE" ? "Port " + c.port + " is in use. Pick another." :
								"Sharing could not start (" + st.error + ").");
						});
						return;
					}
					if (!ftpdPid() && waited < 5000) {
						waited += 200;
						setTimeout(check, 200);
						return;
					}
					if (!ftpdPid()) {
						shareFirewall(c.port, false, function() {
							fail(future, "Sharing could not start.");
						});
						return;
					}
					log("sharing on port " + c.port);
					shareStatus(future);
				})();
			});
		});
	});
	return future;
};

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
function startArchive(future, args, op, then) {
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
		runSteps(steps, then ? phaseEnd(then) : finish);
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
	if (op === "fetch") {
		return startFetch(future, args);
	}
	if ((op === "extract" || op === "pack") && args.net) {
		return startNetArchive(future, args, op);
	}
	if (op === "extract" || op === "pack") {
		return startArchive(future, args, op);
	}
	if (op !== "copy" && op !== "move" && op !== "delete") {
		return fail(future, "Unknown job.");
	}
	if (args.net && args.toNet) {
		return startRelay(future, args, op);
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
