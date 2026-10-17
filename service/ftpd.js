// An FTP server for the TouchPad's storage (node 0.4.12 on webOS 3 / webOS CE,
// ES5 only). The file service starts it as a process of its own, so sharing
// goes on when the app is closed and the service has gone to sleep, and stops
// it again when sharing is switched off:
//
//     node ftpd.js /path/to/settings.json
//
// settings: {root, port, user, pass, readOnly, pasvFrom, pasvTo, pidFile,
//            statusFile}
//
// One name and password signs in; everything below root is shared and nothing
// above it. While it runs it keeps the TouchPad from going to sleep, which
// would take Wi-Fi with it (com.palm.power's activities, renewed as they run
// out). It answers the commands Windows Explorer, FileZilla, curl and the
// usual phone apps use: passive and active connections, LIST, NLST, MLSD and
// MLST, RETR and STOR with REST, APPE, renames, folders, SIZE and MDTM.

var net = require("net");
var fs = require("fs");
var child_process = require("child_process");

// The file service's connections to the system's message hub come along when
// it starts this. Held here, the hub would take the service to be there after
// it has gone to sleep, and the app's calls to it would hang; so they are let
// go before anything else. (node itself has no sockets open yet.)
(function() {
	var fds = [];
	try {
		fds = fs.readdirSync("/proc/self/fd");
	} catch (e) {}
	for (var i = 0; i < fds.length; i++) {
		var fd = parseInt(fds[i], 10);
		try {
			if (fd > 2 && /^socket:/.test(fs.readlinkSync("/proc/self/fd/" + fd))) {
				fs.closeSync(fd);
			}
		} catch (e2) {}
	}
})();

var conf = {};
try {
	conf = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch (e) {
	console.log("ftpd: no settings: " + e);
	process.exit(1);
}
var ROOT = conf.root || "/media/internal";
var PORT = conf.port || 2121;
var PASV_FROM = conf.pasvFrom || 50100;
var PASV_TO = conf.pasvTo || 50119;
var MAX_FAILS = 5;

var clients = 0;
var nextPasv = PASV_FROM;

function log(msg) {
	console.log(new Date().toISOString() + " " + msg);
}

function writeStatus() {
	if (!conf.statusFile) {
		return;
	}
	try {
		fs.writeFileSync(conf.statusFile, JSON.stringify({pid: process.pid, port: PORT, clients: clients}));
	} catch (e) {}
}

// ---- staying awake --------------------------------------------------------------

var ACTIVITY = "com.palm.stark.files.ftp";
var awake = null;

function power(method, params) {
	try {
		var c = child_process.spawn("/usr/bin/luna-send", ["-n", "1",
			"palm://com.palm.power/com/palm/power/" + method, JSON.stringify(params)]);
		c.stdin.end();
	} catch (e) {}
}

function stayAwake() {
	power("activityStart", {id: ACTIVITY, duration_ms: 900000});
	awake = setInterval(function() {
		power("activityStart", {id: ACTIVITY, duration_ms: 900000});
	}, 600000);
}

function stop() {
	if (awake) {
		clearInterval(awake);
		awake = null;
	}
	power("activityEnd", {id: ACTIVITY});
	try {
		fs.unlinkSync(conf.pidFile);
	} catch (e) {}
	try {
		fs.unlinkSync(conf.statusFile);
	} catch (e2) {}
	// Give luna-send a moment before going.
	setTimeout(function() {
		process.exit(0);
	}, 300);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("uncaughtException", function(e) {
	log("ftpd: " + (e && e.stack || e));
});

// ---- paths ----------------------------------------------------------------------

// A path as the client sees it ("/Photos/2013") from the folder it is in and
// what it typed. ".." never climbs above "/".
function virtual(cwd, arg) {
	var p = arg && arg.charAt(0) === "/" ? arg : (cwd === "/" ? "/" : cwd + "/") + (arg || "");
	var out = [];
	var parts = p.split("/");
	for (var i = 0; i < parts.length; i++) {
		if (!parts[i] || parts[i] === ".") {
			continue;
		}
		if (parts[i] === "..") {
			out.pop();
		} else {
			out.push(parts[i]);
		}
	}
	return "/" + out.join("/");
}

function real(v) {
	return v === "/" ? ROOT : ROOT + v;
}

// ---- listings -------------------------------------------------------------------

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function two(n) {
	return (n < 10 ? "0" : "") + n;
}

// "drwxr-xr-x 1 owner group 4096 Mar 31 14:05 name": what clients expect of LIST.
function listLine(name, st) {
	var d = st.mtime;
	var old = Math.abs(new Date().getTime() - d.getTime()) > 180 * 86400000;
	var when = MONTHS[d.getMonth()] + " " + (d.getDate() < 10 ? " " : "") + d.getDate() + " " +
		(old ? " " + d.getFullYear() : two(d.getHours()) + ":" + two(d.getMinutes()));
	var size = String(st.isDirectory() ? 4096 : st.size);
	while (size.length < 12) {
		size = " " + size;
	}
	return (st.isDirectory() ? "drwxr-xr-x" : "-rw-r--r--") + " 1 touchpad touchpad " + size + " " + when + " " + name;
}

function stamp(d) {
	return d.getUTCFullYear() + two(d.getUTCMonth() + 1) + two(d.getUTCDate()) +
		two(d.getUTCHours()) + two(d.getUTCMinutes()) + two(d.getUTCSeconds());
}

// "type=dir;size=0;modify=20230331140500; name": MLSD and MLST.
function factsLine(name, st, cdir) {
	return "type=" + (cdir ? "cdir" : (st.isDirectory() ? "dir" : "file")) + ";size=" + (st.isDirectory() ? 0 : st.size) +
		";modify=" + stamp(st.mtime) + ";perm=" + (st.isDirectory() ? "elcmfd" : "rwadf") + "; " + name;
}

// ---- one client -----------------------------------------------------------------

function Session(sock) {
	this.sock = sock;
	this.cwd = "/";
	this.user = "";
	this.authed = false;
	this.fails = 0;
	this.rest = 0;
	this.renameFrom = null;
	this.pasv = null;       // the listening server for passive mode
	this.data = null;       // the data connection, once there
	this.waiting = null;    // function(sock) wanting the data connection
	this.port = null;       // {host, port} for active mode
	this.busy = false;
	this.text = "";
	var self = this;
	sock.setEncoding("utf8");
	sock.setTimeout(900000);
	sock.on("timeout", function() {
		self.reply(421, "Nothing for a long time; closing.");
		sock.end();
	});
	sock.on("data", function(d) {
		self.text += d;
		var at;
		while ((at = self.text.indexOf("\n")) >= 0) {
			var line = self.text.substring(0, at).replace(/\r$/, "");
			self.text = self.text.substring(at + 1);
			self.command(line);
		}
		if (self.text.length > 8192) {
			sock.destroy();
		}
	});
	sock.on("error", function() {});
	sock.on("close", function() {
		self.closeData();
		clients--;
		writeStatus();
		log("client left: " + self.from);
	});
	this.from = sock.remoteAddress;
	clients++;
	writeStatus();
	log("client: " + this.from);
	this.reply(220, "Topaz Explorer FTP ready.");
}

Session.prototype.reply = function(code, text) {
	try {
		this.sock.write(code + " " + text + "\r\n", "utf8");
	} catch (e) {}
};

Session.prototype.lines = function(code, lines, last) {
	var out = code + "-" + lines[0] + "\r\n";
	for (var i = 1; i < lines.length; i++) {
		out += " " + lines[i] + "\r\n";
	}
	out += code + " " + last + "\r\n";
	try {
		this.sock.write(out, "utf8");
	} catch (e) {}
};

Session.prototype.closeData = function() {
	if (this.data) {
		try { this.data.destroy(); } catch (e) {}
		this.data = null;
	}
	if (this.pasv) {
		try { this.pasv.close(); } catch (e2) {}
		this.pasv = null;
	}
	this.waiting = null;
};

// Open a passive data port and say where it is. epsv: the extended form.
Session.prototype.openPasv = function(epsv) {
	var self = this;
	this.closeData();
	this.port = null;
	var tries = 0;
	function attempt() {
		var p = nextPasv;
		nextPasv = nextPasv >= PASV_TO ? PASV_FROM : nextPasv + 1;
		var srv = net.createServer(function(s) {
			if (self.pasv !== srv) {
				s.destroy();
				return;
			}
			// Only the client that asked may connect.
			if (s.remoteAddress !== self.sock.remoteAddress) {
				s.destroy();
				return;
			}
			try { srv.close(); } catch (e) {}
			self.pasv = null;
			self.data = s;
			s.on("error", function() {});
			if (self.waiting) {
				var w = self.waiting;
				self.waiting = null;
				w(s);
			}
		});
		srv.on("error", function() {
			if (++tries > PASV_TO - PASV_FROM) {
				self.reply(425, "No data port is free.");
				return;
			}
			attempt();
		});
		srv.listen(p, function() {
			self.pasv = srv;
			if (epsv) {
				self.reply(229, "Entering Extended Passive Mode (|||" + p + "|)");
			} else {
				var addr = String(self.sock.address().address || "").replace(/^::ffff:/, "");
				self.reply(227, "Entering Passive Mode (" + addr.split(".").join(",") + "," +
					Math.floor(p / 256) + "," + (p % 256) + ")");
			}
		});
	}
	attempt();
};

// Get the data connection: the passive one (waiting for it if need be) or a
// new active one. then(sock), or a 425 when there is none.
Session.prototype.withData = function(then) {
	var self = this;
	if (this.data) {
		then(this.data);
		return;
	}
	if (this.pasv) {
		this.waiting = then;
		setTimeout(function() {
			if (self.waiting === then) {
				self.waiting = null;
				self.closeData();
				self.reply(425, "The data connection was not made.");
			}
		}, 20000);
		return;
	}
	if (this.port) {
		var s = net.createConnection(this.port.port, this.port.host);
		var done = false;
		s.on("connect", function() {
			done = true;
			self.data = s;
			then(s);
		});
		s.on("error", function() {
			if (!done) {
				done = true;
				self.reply(425, "Could not open the data connection.");
			}
		});
		return;
	}
	this.reply(425, "Use PASV or PORT first.");
};

// Send text (a listing) over the data connection.
Session.prototype.sendText = function(text, what) {
	var self = this;
	this.withData(function(s) {
		self.reply(150, "Here comes " + what + ".");
		s.end(new Buffer(text, "utf8"));
		s.on("close", function() {
			self.data = null;
			self.reply(226, "Done.");
		});
	});
};

Session.prototype.need = function(write) {
	if (!this.authed) {
		this.reply(530, "Sign in first.");
		return false;
	}
	if (write && conf.readOnly) {
		this.reply(550, "This TouchPad is shared read-only.");
		return false;
	}
	return true;
};

Session.prototype.command = function(line) {
	var sp = line.indexOf(" ");
	var cmd = (sp < 0 ? line : line.substring(0, sp)).toUpperCase();
	var arg = sp < 0 ? "" : line.substring(sp + 1);
	var self = this;
	var v, p;
	// RNFR holds only for the command right after it.
	var renameFrom = this.renameFrom;
	this.renameFrom = null;

	switch (cmd) {
	case "USER":
		this.user = arg;
		this.authed = false;
		this.reply(331, "Password, please.");
		return;
	case "PASS":
		if (this.user === conf.user && arg === conf.pass) {
			this.authed = true;
			this.fails = 0;
			this.reply(230, "Signed in.");
			log("signed in: " + this.from);
			return;
		}
		this.fails++;
		log("wrong sign-in from " + this.from);
		// A pause makes guessing slow.
		setTimeout(function() {
			self.reply(530, "Wrong name or password.");
			if (self.fails >= MAX_FAILS) {
				self.sock.end();
			}
		}, 2000);
		return;
	case "QUIT":
		this.reply(221, "Goodbye.");
		this.sock.end();
		return;
	case "NOOP":
		this.reply(200, "OK.");
		return;
	case "SYST":
		this.reply(215, "UNIX Type: L8");
		return;
	case "FEAT":
		this.lines(211, ["Features:", "UTF8", "EPSV", "PASV", "REST STREAM", "SIZE", "MDTM",
			"MLST type*;size*;modify*;perm*;", "MLSD"], "End");
		return;
	case "OPTS":
		this.reply(/^utf8\b/i.test(arg) ? 200 : 501, /^utf8\b/i.test(arg) ? "Always in UTF-8." : "Not known.");
		return;
	case "AUTH":
		this.reply(502, "Only plain FTP here.");
		return;
	case "CLNT":
		this.reply(200, "Hello.");
		return;
	case "HELP":
		this.reply(214, "Ask away.");
		return;
	}

	if (!this.need(false)) {
		return;
	}
	switch (cmd) {
	case "PWD":
	case "XPWD":
		this.reply(257, "\"" + this.cwd.replace(/"/g, "\"\"") + "\" is the folder.");
		return;
	case "CWD":
	case "XCWD":
	case "CDUP":
	case "XCUP":
		v = virtual(this.cwd, cmd === "CDUP" || cmd === "XCUP" ? ".." : arg);
		fs.stat(real(v), function(err, s) {
			if (err || !s.isDirectory()) {
				self.reply(550, "No such folder.");
				return;
			}
			self.cwd = v;
			self.reply(250, "Now in " + v + ".");
		});
		return;
	case "TYPE":
		this.reply(200, "Type set.");
		return;
	case "MODE":
		this.reply(/^s$/i.test(arg) ? 200 : 504, "Stream mode only.");
		return;
	case "STRU":
		this.reply(/^f$/i.test(arg) ? 200 : 504, "File structure only.");
		return;
	case "ALLO":
		this.reply(202, "No need.");
		return;
	case "PASV":
		this.openPasv(false);
		return;
	case "EPSV":
		if (/^all$/i.test(arg)) {
			this.reply(200, "EPSV only, then.");
			return;
		}
		this.openPasv(true);
		return;
	case "PORT":
		p = arg.split(",");
		if (p.length !== 6) {
			this.reply(501, "Bad PORT.");
			return;
		}
		this.closeData();
		this.port = {host: p.slice(0, 4).join("."), port: Number(p[4]) * 256 + Number(p[5])};
		if (this.port.host !== this.sock.remoteAddress) {
			// Data goes only to the client itself.
			this.port = null;
			this.reply(500, "PORT must point at you.");
			return;
		}
		this.reply(200, "PORT set.");
		return;
	case "EPRT":
		p = arg.split(arg.charAt(0));
		if (p.length < 4 || p[2] !== this.sock.remoteAddress) {
			this.reply(500, "EPRT must point at you.");
			return;
		}
		this.closeData();
		this.port = {host: p[2], port: Number(p[3])};
		this.reply(200, "EPRT set.");
		return;
	case "REST":
		this.rest = Math.max(0, parseInt(arg, 10) || 0);
		this.reply(350, "Starting at " + this.rest + ".");
		return;
	case "ABOR":
		this.closeData();
		this.reply(226, "Stopped.");
		return;
	case "LIST":
	case "NLST":
	case "MLSD":
		// "LIST -la" and the like: the options are not needed.
		arg = arg.replace(/^(-\S+\s*)+/, "");
		v = virtual(this.cwd, arg);
		this.list(cmd, v);
		return;
	case "MLST":
		v = virtual(this.cwd, arg);
		fs.stat(real(v), function(err, s) {
			if (err) {
				self.reply(550, "Not found.");
				return;
			}
			self.lines(250, ["Listing " + v, factsLine(v, s, false)], "End");
		});
		return;
	case "SIZE":
	case "MDTM":
		v = virtual(this.cwd, arg);
		fs.stat(real(v), function(err, s) {
			if (err || s.isDirectory()) {
				self.reply(550, "No such file.");
				return;
			}
			self.reply(213, cmd === "SIZE" ? String(s.size) : stamp(s.mtime));
		});
		return;
	case "RETR":
		v = virtual(this.cwd, arg);
		this.retr(v);
		return;
	case "STOR":
	case "APPE":
		if (!this.need(true)) {
			return;
		}
		v = virtual(this.cwd, arg);
		this.stor(v, cmd === "APPE");
		return;
	case "DELE":
		if (!this.need(true)) {
			return;
		}
		v = virtual(this.cwd, arg);
		fs.unlink(real(v), function(err) {
			self.reply(err ? 550 : 250, err ? "Could not delete it." : "Deleted.");
		});
		return;
	case "MKD":
	case "XMKD":
		if (!this.need(true)) {
			return;
		}
		v = virtual(this.cwd, arg);
		fs.mkdir(real(v), 493 /* 0755 */, function(err) {
			if (err) {
				self.reply(550, "Could not make the folder.");
			} else {
				self.reply(257, "\"" + v.replace(/"/g, "\"\"") + "\" made.");
			}
		});
		return;
	case "RMD":
	case "XRMD":
		if (!this.need(true)) {
			return;
		}
		v = virtual(this.cwd, arg);
		if (v === "/") {
			this.reply(550, "Not the top.");
			return;
		}
		fs.rmdir(real(v), function(err) {
			self.reply(err ? 550 : 250, err ? "Could not remove the folder (is it empty?)." : "Removed.");
		});
		return;
	case "RNFR":
		if (!this.need(true)) {
			return;
		}
		v = virtual(this.cwd, arg);
		fs.stat(real(v), function(err) {
			if (err || v === "/") {
				self.reply(550, "Not found.");
				return;
			}
			self.renameFrom = v;
			self.reply(350, "And the new name?");
		});
		return;
	case "RNTO":
		if (!this.need(true)) {
			return;
		}
		var was = renameFrom;
		if (!was) {
			this.reply(503, "RNFR first.");
			return;
		}
		v = virtual(this.cwd, arg);
		fs.stat(real(v), function(err) {
			// Never over something that is there.
			if (!err) {
				self.reply(553, "Something by that name is already there.");
				return;
			}
			fs.rename(real(was), real(v), function(err2) {
				self.reply(err2 ? 553 : 250, err2 ? "Could not rename it." : "Renamed.");
			});
		});
		return;
	case "STAT":
		this.reply(211, "Topaz Explorer FTP; " + clients + " connected.");
		return;
	case "SITE":
		this.reply(502, "No SITE commands.");
		return;
	}
	this.reply(502, "Not known.");
};

Session.prototype.list = function(cmd, v) {
	var self = this;
	var path = real(v);
	fs.stat(path, function(err, top) {
		if (err) {
			self.reply(550, "Not found.");
			return;
		}
		if (!top.isDirectory()) {
			// LIST of a single file lists just it.
			var name = v.substring(v.lastIndexOf("/") + 1);
			self.sendText((cmd === "NLST" ? name : cmd === "MLSD" ? factsLine(name, top, false) : listLine(name, top)) + "\r\n",
				"the listing");
			return;
		}
		fs.readdir(path, function(err2, names) {
			if (err2) {
				self.reply(550, "The folder could not be read.");
				return;
			}
			var out = [];
			if (cmd === "MLSD") {
				out.push(factsLine(".", top, true));
			}
			var at = 0;
			(function next() {
				if (at >= names.length) {
					self.sendText(out.length ? out.join("\r\n") + "\r\n" : "", "the listing");
					return;
				}
				var n = names[at++];
				fs.stat(path + "/" + n, function(err3, s) {
					if (!err3) {
						out.push(cmd === "NLST" ? n : cmd === "MLSD" ? factsLine(n, s, false) : listLine(n, s));
					}
					next();
				});
			})();
		});
	});
};

Session.prototype.retr = function(v) {
	var self = this;
	var start = this.rest;
	this.rest = 0;
	fs.stat(real(v), function(err, s) {
		if (err || s.isDirectory()) {
			self.reply(550, "No such file.");
			return;
		}
		self.withData(function(sock) {
			self.reply(150, "Sending " + v.substring(v.lastIndexOf("/") + 1) + " (" + (s.size - start) + " bytes).");
			if (start >= s.size) {
				sock.end();
				self.data = null;
				self.reply(226, "Done.");
				return;
			}
			var rs = fs.createReadStream(real(v), start ? {start: start, end: s.size - 1} : {});
			var failed = false;
			rs.on("error", function() {
				failed = true;
				sock.destroy();
			});
			sock.on("close", function() {
				self.data = null;
				self.reply(failed ? 451 : 226, failed ? "Reading the file failed." : "Done.");
			});
			rs.pipe(sock);
		});
	});
};

Session.prototype.stor = function(v, append) {
	var self = this;
	var start = this.rest;
	this.rest = 0;
	if (v === "/") {
		this.reply(553, "That is a folder.");
		return;
	}
	var opts = append ? {flags: "a"} : (start ? {flags: "r+", start: start} : {flags: "w"});
	this.withData(function(sock) {
		var ws;
		try {
			ws = fs.createWriteStream(real(v), opts);
		} catch (e) {
			sock.destroy();
			self.reply(553, "Could not write it.");
			return;
		}
		var failed = false;
		var replied = false;
		function end(code, text) {
			if (!replied) {
				replied = true;
				self.data = null;
				self.reply(code, text);
			}
		}
		ws.on("error", function() {
			failed = true;
			sock.destroy();
			end(451, "Writing the file failed (is the storage full, or the file over 4 GB?).");
		});
		ws.on("close", function() {
			end(failed ? 451 : 226, failed ? "Writing the file failed." : "Saved.");
		});
		self.reply(150, "Go ahead.");
		sock.pipe(ws);
	});
};

// ---- the server -------------------------------------------------------------------

var server = net.createServer(function(sock) {
	new Session(sock);
});
server.on("error", function(e) {
	log("ftpd could not start: " + e);
	try {
		fs.writeFileSync(conf.statusFile, JSON.stringify({error: String(e.code || e)}));
	} catch (e2) {}
	process.exit(1);
});
server.listen(PORT, function() {
	try {
		fs.writeFileSync(conf.pidFile, String(process.pid));
	} catch (e) {}
	writeStatus();
	stayAwake();
	log("sharing " + ROOT + " on port " + PORT + (conf.readOnly ? ", read-only" : ""));
});
