/* Shared helpers: paths, kinds of file, sizes and dates, settings. */
var FM = FM || {};

// Two places to start from: the TouchPad's own storage, where things can be
// changed, and the whole system, which can only be looked at.
FM.ROOT = "/media/internal";
FM.ROOT_NAME = "My TouchPad";
FM.SYSTEM = "/";
FM.SYSTEM_NAME = "System";

FM.log = function(msg) {
	try { console.log("[files] " + msg); } catch (e) {}
};

// ---- paths ----

// Whether a path is on the TouchPad's own storage.
FM.inStorage = function(path) {
	return path === FM.ROOT || path.indexOf(FM.ROOT + "/") === 0;
};

// Whether a path is in a folder that shows the running system, not a disk.
FM.live = function(path) {
	return /^\/(proc|sys|dev)(\/|$)/.test(path);
};

FM.join = function(dir, name) {
	return dir === "/" ? "/" + name : dir + "/" + name;
};

FM.parentOf = function(path) {
	return path.substring(0, path.lastIndexOf("/")) || "/";
};

FM.nameOf = function(path) {
	if (path === FM.ROOT) {
		return FM.ROOT_NAME;
	}
	return path === FM.SYSTEM ? FM.SYSTEM_NAME : path.substring(path.lastIndexOf("/") + 1);
};

// The folders from the storage, or from the top of the system, down to a path: [{name, path}]
FM.trail = function(path) {
	var stored = FM.inStorage(path);
	var out = [stored ? {name: FM.ROOT_NAME, path: FM.ROOT} : {name: FM.SYSTEM_NAME, path: FM.SYSTEM}];
	var rest = path.substring(stored ? FM.ROOT.length : 0).split("/");
	var at = stored ? FM.ROOT : "";
	for (var i = 0; i < rest.length; i++) {
		if (rest[i]) {
			at += "/" + rest[i];
			out.push({name: rest[i], path: at});
		}
	}
	return out;
};

// A folder as people would say it: "My TouchPad/Photos/2013". System folders keep their paths.
FM.place = function(path) {
	path = String(path || "");
	return FM.inStorage(path) ? FM.ROOT_NAME + path.substring(FM.ROOT.length) : path;
};

// Order names the way Explorer does: "File 2" before "File 10".
FM.natural = function(a, b) {
	var ra = /(\d+)|(\D+)/g;
	var rb = /(\d+)|(\D+)/g;
	for (;;) {
		var ma = ra.exec(a);
		var mb = rb.exec(b);
		if (!ma || !mb) {
			return ma ? 1 : (mb ? -1 : 0);
		}
		if (ma[1] && mb[1]) {
			var d = Number(ma[1]) - Number(mb[1]);
			if (d) {
				return d;
			}
		} else if (ma[0] !== mb[0]) {
			return ma[0] < mb[0] ? -1 : 1;
		}
	}
};

FM.fileUrl = function(path) {
	return "file://" + encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
};

// A small picture of an image file, made by the system. For a style rule.
FM.thumbUrl = function(path, px) {
	return "url('/var/luna/data/extractfs" + encodeURIComponent(path).replace(/'/g, "%27") +
		":0:0:" + px + ":" + px + ":3')";
};

// ---- kinds of file ----

// extension -> [family, what Explorer would call it]
FM.KINDS = {
	jpg: ["image", "JPEG image"], jpeg: ["image", "JPEG image"], png: ["image", "PNG image"],
	gif: ["image", "GIF image"], bmp: ["image", "Bitmap image"], tif: ["image", "TIFF image"],
	tiff: ["image", "TIFF image"], svg: ["image", "SVG image"], webp: ["image", "WebP image"],
	mp3: ["audio", "MP3 audio"], m4a: ["audio", "MPEG-4 audio"], aac: ["audio", "AAC audio"],
	wav: ["audio", "Wave sound"], ogg: ["audio", "Ogg audio"], flac: ["audio", "FLAC audio"],
	wma: ["audio", "Windows Media audio"], amr: ["audio", "AMR audio"], opus: ["audio", "Opus audio"],
	mp4: ["video", "MPEG-4 video"], m4v: ["video", "MPEG-4 video"], mov: ["video", "QuickTime video"],
	avi: ["video", "AVI video"], mkv: ["video", "Matroska video"], wmv: ["video", "Windows Media video"],
	"3gp": ["video", "3GPP video"], "3g2": ["video", "3GPP2 video"], ts: ["video", "MPEG-TS video"],
	webm: ["video", "WebM video"], flv: ["video", "Flash video"],
	doc: ["doc", "Word document"], docx: ["doc", "Word document"], odt: ["doc", "OpenDocument text"],
	rtf: ["doc", "Rich text document"], pdf: ["pdf", "PDF document"],
	xls: ["sheet", "Excel spreadsheet"], xlsx: ["sheet", "Excel spreadsheet"],
	ods: ["sheet", "OpenDocument spreadsheet"], csv: ["sheet", "Comma-separated values"],
	ppt: ["slides", "PowerPoint presentation"], pptx: ["slides", "PowerPoint presentation"],
	odp: ["slides", "OpenDocument presentation"],
	txt: ["text", "Text document"], log: ["text", "Log file"], md: ["text", "Markdown document"],
	ini: ["text", "Settings file"], cfg: ["text", "Settings file"], conf: ["text", "Settings file"],
	json: ["text", "JSON file"], xml: ["text", "XML file"], html: ["text", "Web page"],
	htm: ["text", "Web page"], css: ["text", "Style sheet"], js: ["text", "JavaScript file"],
	sh: ["text", "Shell script"], patch: ["text", "Patch file"], vcf: ["text", "Contact card"],
	ics: ["text", "Calendar file"], yml: ["text", "YAML file"], yaml: ["text", "YAML file"],
	toml: ["text", "TOML file"], properties: ["text", "Settings file"], list: ["text", "List file"],
	c: ["text", "C source file"], h: ["text", "C header file"], cpp: ["text", "C++ source file"],
	py: ["text", "Python script"], pl: ["text", "Perl script"], lua: ["text", "Lua script"],
	sql: ["text", "SQL file"], diff: ["text", "Patch file"], nfo: ["text", "Information file"],
	bat: ["text", "Batch file"], ps1: ["text", "PowerShell script"], mk: ["text", "Makefile"],
	zip: ["archive", "Zip archive"], gz: ["archive", "Gzip archive"], tgz: ["archive", "Tar archive"],
	tar: ["archive", "Tar archive"], bz2: ["archive", "Bzip2 archive"], "7z": ["archive", "7-Zip archive"],
	rar: ["archive", "RAR archive"], xz: ["archive", "XZ archive"], tbz2: ["archive", "Tar archive"],
	txz: ["archive", "Tar archive"], cab: ["archive", "Cabinet archive"], lzh: ["archive", "LZH archive"],
	arj: ["archive", "ARJ archive"], cpio: ["archive", "Cpio archive"], rpm: ["archive", "RPM package"],
	deb: ["archive", "Debian package"], jar: ["archive", "Java archive"],
	cbz: ["comic", "Comic book"], cbr: ["comic", "Comic book"],
	ipk: ["app", "webOS package"], apk: ["app", "Android package"],
	epub: ["book", "EPUB book"], mobi: ["book", "Kindle book"], azw: ["book", "Kindle book"],
	db: ["data", "Database"], db3: ["data", "Database"], sqlite: ["data", "Database"],
	iso: ["data", "Disc image"], img: ["data", "Disk image"], bin: ["data", "Binary file"],
	sav: ["data", "Saved game"], dat: ["data", "Data file"]
};

// Fill in what the lists show for one entry from the service ({n, d, s, m, l}).
FM.dress = function(e, dir) {
	e.path = FM.join(e.p || dir, e.n);
	e.key = e.n.toLowerCase();
	if (e.d) {
		e.ext = "";
		e.family = "folder";
		e.type = e.l ? "Link to a folder" : "File folder";
	} else {
		var dot = e.n.lastIndexOf(".");
		e.ext = dot > 0 ? e.n.substring(dot + 1).toLowerCase() : "";
		var k = FM.KINDS[e.ext];
		e.family = k ? k[0] : "file";
		e.type = k ? k[1] : (e.ext ? e.ext.toUpperCase() + " file" : "File");
	}
	// The letters on the icon: short extensions only.
	e.tag = (!e.d && e.ext.length <= 4) ? e.ext.toUpperCase() : "";
	e.sel = false;
	return e;
};

// Whether Topaz Explorer can show an entry itself, as a picture.
FM.isPicture = function(e) {
	return !e.d && /^(jpe?g|png|bmp|gif)$/.test(e.ext);
};

// Whether Topaz Explorer opens an entry in its own text editor. Web pages, contact
// cards and calendar files go to the apps that show them.
FM.isText = function(e) {
	return !e.d && e.family === "text" && !/^(html?|vcf|ics)$/.test(e.ext);
};

// Whether an entry is an archive Topaz Explorer can extract. Comic books are archives
// too, but they are for reading.
FM.isArchive = function(e) {
	return !e.d && (e.family === "archive" || e.ext === "iso");
};

// ---- sizes and dates ----

FM.size = function(bytes) {
	if (bytes < 1024) {
		return bytes + " bytes";
	}
	var units = ["KB", "MB", "GB", "TB"];
	var n = bytes / 1024;
	var u = 0;
	while (n >= 1024 && u < units.length - 1) {
		n /= 1024;
		u++;
	}
	return (n >= 100 ? Math.round(n) : (n >= 10 ? n.toFixed(1) : n.toFixed(2))) + " " + units[u];
};

FM.when = function(ms) {
	if (!ms) {
		return "";
	}
	var d = new Date(ms);
	var h = d.getHours();
	var m = d.getMinutes();
	return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear() + " " +
		(h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "AM" : "PM");
};

FM.count = function(n, one, many) {
	return n + " " + (n === 1 ? one : (many || one + "s"));
};

// A rough length of time from milliseconds: "about 40 sec", "about 3 min".
FM.duration = function(ms) {
	var sec = Math.round(ms / 1000);
	if (sec < 60) {
		return "about " + Math.max(1, sec) + " sec";
	}
	var min = Math.round(sec / 60);
	if (min < 60) {
		return "about " + FM.count(min, "min", "min");
	}
	var hr = Math.floor(min / 60);
	var rem = min % 60;
	return "about " + FM.count(hr, "hour") + (rem ? " " + rem + " min" : "");
};

// ---- settings ----

FM.pref = function(key, fallback) {
	try {
		var v = localStorage.getItem("fm." + key);
		return v === null || v === undefined ? fallback : v;
	} catch (e) {
		return fallback;
	}
};

FM.setPref = function(key, value) {
	try {
		localStorage.setItem("fm." + key, String(value));
	} catch (e) {}
};

FM.banner = function(text) {
	try {
		enyo.windows.addBannerMessage(text, "{}");
	} catch (e) {
		FM.log(text);
	}
};
