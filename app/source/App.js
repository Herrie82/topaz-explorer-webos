/* The app: back, forward and up with the path across the top, the folder tree
	on the left, the folder's contents on the right, and the actions below. */
enyo.kind({
	name: "FM.App",
	kind: enyo.VFlexBox,
	className: "fm-app",
	components: [
		{kind: "ApplicationEvents", onBack: "backGesture", onWindowParamsChange: "windowParamsChanged"},
		{name: "svc", kind: "FM.Service"},

		{name: "pane", kind: "Pane", flex: 1, transitionKind: "enyo.transitions.Simple", components: [
			{name: "browse", kind: "VFlexBox", components: [
				{kind: "HFlexBox", align: "center", className: "fm-top", components: [
					{name: "back", kind: "IconButton", icon: "images/back.png", className: "enyo-button-dark fm-nav", onclick: "goBack"},
					{name: "forward", kind: "IconButton", icon: "images/forward.png", className: "enyo-button-dark fm-nav", onclick: "goForward"},
					{name: "up", kind: "IconButton", icon: "images/up.png", className: "enyo-button-dark fm-nav", onclick: "goUp"},
					{name: "crumbs", kind: "HFlexBox", flex: 1, align: "center", className: "fm-crumbs"},
					{name: "search", kind: "SearchInput", hint: "Search", className: "fm-search",
						onchange: "searchChanged", onCancel: "searchChanged",
						autoCapitalize: "lowercase", autocorrect: false, spellcheck: false, changeOnInput: true}
				]},

				{kind: "HFlexBox", flex: 1, components: [
					{name: "tree", kind: "FM.Tree", onPick: "treePick"},
					{kind: "VFlexBox", flex: 1, components: [
						{name: "searchBar", kind: "HFlexBox", align: "center", className: "fm-searchbar", showing: false, components: [
							{name: "searchNote", flex: 1, className: "fm-one-line"},
							{name: "deep", kind: "Button", caption: "Search Subfolders", onclick: "deepSearch"}
						]},
						{name: "files", kind: "FM.FileView", flex: 1, onOpen: "openEntry", onSelection: "selectionChanged",
							onSort: "sortPicked"}
					]}
				]},

				// The bar when nothing is selected...
				{name: "bar", kind: "HFlexBox", align: "center", className: "fm-bottom", components: [
					{kind: "Button", caption: "Folders", className: "enyo-button-dark", onclick: "toggleTree"},
					{name: "newBtn", kind: "Button", caption: "New Folder", className: "enyo-button-dark", onclick: "newFolder"},
					{name: "paste", kind: "Button", caption: "Paste", className: "enyo-button-blue", onclick: "paste", showing: false},
					{name: "status", flex: 1, className: "fm-status"},
					{kind: "Button", caption: "Select", className: "enyo-button-dark", onclick: "selectClick"},
					{name: "sortBtn", kind: "Button", caption: "Sort", className: "enyo-button-dark", onclick: "sortClick"},
					{name: "viewBtn", kind: "Button", caption: "Icons", className: "enyo-button-dark", onclick: "toggleView"}
				]},
				// ...and the bar while things are being selected.
				{name: "selBar", kind: "HFlexBox", align: "center", className: "fm-bottom fm-bottom-selecting", showing: false, components: [
					{name: "copy", kind: "Button", caption: "Copy", className: "enyo-button-dark", onclick: "copyClick"},
					{name: "cut", kind: "Button", caption: "Cut", className: "enyo-button-dark", onclick: "cutClick"},
					{name: "del", kind: "Button", caption: "Delete", className: "enyo-button-negative", onclick: "deleteClick"},
					{name: "more", kind: "Button", caption: "More", className: "enyo-button-dark", onclick: "moreClick"},
					{name: "selStatus", flex: 1, className: "fm-status"},
					{kind: "Button", caption: "Select All", className: "enyo-button-dark", onclick: "selectAllClick"},
					{kind: "Button", caption: "Done", className: "enyo-button-blue", onclick: "doneSelecting"}
				]}
			]},
			{name: "viewer", kind: "FM.Viewer", onClose: "closeViewer"},
			{name: "editor", kind: "FM.Editor", onClose: "closeEditor", onSave: "saveText"}
		]},

		// lazy: false, so the menu's items exist before it is first opened.
		{name: "moreMenu", kind: "Menu", lazy: false, components: [
			{name: "rename", caption: "Rename", onclick: "renameClick"},
			{name: "pack", caption: "Compress", onclick: "packClick"},
			{name: "info", caption: "Details", onclick: "detailsClick"}
		]},
		{name: "archiveMenu", kind: "Menu", lazy: false, components: [
			{name: "extractTo", caption: "Extract to a Folder", onclick: "extractToFolder"},
			{caption: "Extract Here", onclick: "extractHere"}
		]},
		{name: "sortMenu", kind: "Menu", lazy: false, components: [
			{caption: "Name", sortKey: "name", onclick: "sortMenuPicked"},
			{caption: "Date modified", sortKey: "date", onclick: "sortMenuPicked"},
			{caption: "Type", sortKey: "type", onclick: "sortMenuPicked"},
			{caption: "Size", sortKey: "size", onclick: "sortMenuPicked"}
		]},
		{kind: "AppMenu", lazy: false, components: [
			{name: "hiddenItem", caption: "Show Hidden Files", onclick: "toggleHidden"},
			{name: "systemItem", caption: "Allow System Changes", onclick: "toggleSystem"},
			{caption: "Refresh", onclick: "refreshClick"}
		]},
		{name: "nameDialog", kind: "FM.NameDialog"},
		{name: "confirmDialog", kind: "FM.ConfirmDialog"},
		{name: "conflictDialog", kind: "FM.ConflictDialog"},
		{name: "progressDialog", kind: "FM.ProgressDialog", onCancel: "cancelJob"},
		{name: "detailsDialog", kind: "FM.DetailsDialog"}
	],

	create: function() {
		this.inherited(arguments);
		this.path = "";
		this.entries = [];
		this.backs = [];         // folders to go back to
		this.forwards = [];      // folders to go forward to
		this.clip = null;        // {op: "copy" or "move", paths, from}
		this.free = -1;
		this.loads = 0;
		this.wakes = 0;
		// Changes outside the storage are allowed. Off again at every start.
		this.system = false;
		this.awake = false;
		this.hidden = FM.pref("hidden", "0") === "1";
		this.treeShown = FM.pref("tree", "1") === "1";
	},

	rendered: function() {
		this.inherited(arguments);
		if (this.begun) {
			return;
		}
		this.begun = true;
		this.$.files.setView(FM.pref("view", "details"));
		this.$.files.setSortKey(FM.pref("sortKey", "name"));
		this.$.files.setSortDown(FM.pref("sortDown", "0") === "1");
		this.$.files.setHidden(this.hidden);
		this.$.tree.setHidden(this.hidden);
		this.$.tree.setShowing(this.treeShown);
		this.showChoices();
		this.path = FM.ROOT;
		this.showCrumbs();
		this.showNav();
		this.wake(0);
	},

	// Wait for the file helper to answer, then show the first folder. Right after
	// the app is installed the helper needs a moment to set itself up, and a call
	// made before that is never answered; so ask again until one is.
	wake: function(tries) {
		var self = this;
		var turn = ++this.wakes;
		this.$.svc.ask("status", {}, function(r) {
			if (self.awake || !r.ok) {
				return;
			}
			self.awake = true;
			// Should an earlier run have left the system disk open, close it.
			self.$.svc.ask("unlock", {on: false}, function() {});
			self.$.files.showNote("");
			self.path = "";
			if (!self.launched(enyo.windowParams || {})) {
				self.go(FM.ROOT, "start");
			}
		});
		setTimeout(function() {
			if (self.awake || turn !== self.wakes) {
				return;
			}
			if (tries >= 8) {
				self.$.files.showNote("The file helper did not start. Close Topaz Explorer and open it again.");
				return;
			}
			self.wake(tries + 1);
		}, 2500);
	},

	windowParamsChanged: function() {
		if (!this.awake) {
			return;
		}
		this.launched(enyo.windowParams || {});
	},

	// Launched to show a folder: {path: "/media/internal/Photos"} or
	// {target: "file:///media/internal/Photos"}; {view: "icons"} picks the view.
	launched: function(params) {
		if (params.view === "icons" || params.view === "details") {
			this.$.files.setView(params.view);
			this.showChoices();
		}
		var path = params.path || params.target;
		if (!path) {
			return false;
		}
		this.showFirst = params.show || "";
		path = String(path).replace(/^file:\/\//, "");
		try {
			path = decodeURIComponent(path);
		} catch (e) {}
		this.go(path.replace(/\/+$/, "") || FM.ROOT);
		return true;
	},

	// ---- going places ----

	// how: "history" when moving along back/forward, "start" for the first folder.
	go: function(path, how) {
		if (path.charAt(0) !== "/") {
			path = FM.ROOT;
		}
		if (!how && this.path && path !== this.path) {
			this.backs.push(this.path);
			this.forwards = [];
		}
		this.path = path;
		if (this.$.search.getValue()) {
			this.$.search.setValue("");
		}
		this.searching = "";
		this.$.files.setFilter("");
		this.$.searchBar.hide();
		this.load(how === "start");
	},

	// Read the folder being shown. Selection and scroll position start over.
	load: function(first) {
		var path = this.path;
		var turn = ++this.loads;
		var self = this;
		this.showCrumbs();
		this.showNav();
		this.showChoices();
		this.$.svc.ask("list", {path: path}, function(r) {
			if (turn !== self.loads) {
				return;      // a later folder was asked for meanwhile
			}
			if (!r.ok) {
				self.entries = [];
				self.$.files.showFolder([]);
				self.$.files.showNote(r.error);
				self.showStatus();
				return;
			}
			var entries = r.entries;
			for (var i = 0; i < entries.length; i++) {
				FM.dress(entries[i], path);
			}
			self.entries = entries;
			if (self.deepShown) {
				// Back from search results to the folder itself, still narrowed.
				self.deepShown = false;
				self.$.deep.show();
				self.$.searchNote.setContent("In this folder: names containing \"" + self.searching + "\"");
			}
			self.$.files.showFolder(entries);
			self.$.tree.reveal(path);
			self.showStatus();
			if (self.showFirst) {
				// Launched with {path: folder, show: name}: open that file from it.
				var wanted = self.showFirst;
				self.showFirst = "";
				for (var k = 0; k < entries.length; k++) {
					if (entries[k].n === wanted) {
						self.openEntry(self, entries[k]);
						break;
					}
				}
			}
		});
		this.readSpace();
	},

	refreshClick: function() {
		this.load();
		this.$.tree.reload(this.path);
	},

	readSpace: function() {
		var self = this;
		var path = this.path;
		this.$.svc.ask("space", {path: path}, function(r) {
			if (path === self.path) {
				self.free = r.ok ? r.free : -1;
				self.showStatus();
			}
		});
	},

	goBack: function() {
		if (this.backs.length) {
			this.forwards.push(this.path);
			this.go(this.backs.pop(), "history");
		}
	},

	goForward: function() {
		if (this.forwards.length) {
			this.backs.push(this.path);
			this.go(this.forwards.pop(), "history");
		}
	},

	goUp: function() {
		if (this.path !== FM.ROOT) {
			this.go(FM.parentOf(this.path));
		}
	},

	treePick: function(inSender, path) {
		this.go(path);
	},

	crumbClick: function(inSender) {
		this.go(inSender.crumbPath);
	},

	backGesture: function(inSender, inEvent) {
		if (this.$.pane.getViewName() === "viewer") {
			this.closeViewer();
		} else if (this.$.pane.getViewName() === "editor") {
			this.closeEditor(this, this.$.editor.isChanged());
		} else if (this.$.files.selecting) {
			this.doneSelecting();
		} else if (this.backs.length) {
			this.goBack();
		} else {
			return;
		}
		inEvent.preventDefault();
		return true;
	},

	openEntry: function(inSender, e) {
		if (e.d) {
			this.go(e.path);
			return;
		}
		if (FM.isPicture(e)) {
			this.viewPicture(e);
			return;
		}
		if (FM.isText(e)) {
			this.editText(e, false);
			return;
		}
		if (FM.isArchive(e)) {
			this.askExtract(e);
			return;
		}
		var self = this;
		this.$.svc.openFile(e.path, function(r) {
			if (!r.ok) {
				// No app takes it. If it turns out to be text, Topaz Explorer shows it itself.
				FM.log("open " + e.path + ": " + enyo.json.stringify(r.raw || r.error));
				self.editText(e, true);
			}
		});
	},

	// ---- archives ----

	// An archive was tapped: offer to unpack it.
	askExtract: function(e) {
		if (!this.canChange()) {
			FM.banner("Copy the archive to My TouchPad to extract it");
			return;
		}
		this.archive = e;
		this.$.extractTo.setCaption("Extract to \"" + this.folderFor(e.n) + "\"");
		this.$.archiveMenu.openAtCenter();
	},

	// The folder an archive would be unpacked into: its name without the ending.
	folderFor: function(name) {
		return name.replace(/\.(tar\.(gz|bz2|xz|z)|[a-z0-9]+)$/i, "") || name;
	},

	extractToFolder: function() {
		if (this.archive) {
			this.runJob("extract", [this.archive.path], this.path, "", {folder: this.folderFor(this.archive.n)});
		}
	},

	extractHere: function() {
		if (this.archive) {
			this.runJob("extract", [this.archive.path], this.path, "", {});
		}
	},

	moreClick: function() {
		this.$.moreMenu.openAroundControl(this.$.more);
	},

	// Make an archive of what is selected. The name's ending picks the kind.
	packClick: function() {
		var picked = this.$.files.getSelected();
		var paths = this.pickedPaths();
		var self = this;
		var dest = this.path;
		if (!paths.length) {
			return;
		}
		var stem = picked.length === 1 ? (picked[0].d ? picked[0].n : this.folderFor(picked[0].n)) : FM.nameOf(dest);
		this.$.nameDialog.ask("Compress (.zip, .7z or .tar)", stem + ".zip", "Compress", function(name) {
			self.runJob("pack", paths, dest, "", {name: name}, function(error) {
				if (error) {
					self.$.nameDialog.showProblem(error);
				} else {
					self.$.nameDialog.done();
				}
			});
		});
	},

	// Open a file in the text editor. lastResort: nothing else would open it, so
	// a file that is not text gets the plain "no app" answer.
	editText: function(e, lastResort) {
		var self = this;
		this.$.svc.ask("read", {path: e.path}, function(r) {
			if (!r.ok) {
				FM.banner(lastResort && r.binary ?
					(e.ext ? "No app here opens ." + e.ext + " files" : "No app here opens this file") : r.error);
				return;
			}
			self.editing = {entry: e, enc: r.enc, crlf: r.crlf, saved: false};
			self.$.editor.openText(e.n, r.text, self.canChange());
			self.$.pane.selectViewByName("editor");
		});
	},

	saveText: function(inSender, text) {
		var self = this;
		var ed = this.editing;
		if (!ed) {
			return;
		}
		this.$.svc.ask("write", {path: ed.entry.path, text: text, enc: ed.enc, crlf: ed.crlf, system: this.system}, function(r) {
			if (!r.ok) {
				FM.banner(r.error);
				return;
			}
			ed.saved = true;
			self.$.editor.markSaved();
			FM.banner("Saved");
		});
	},

	closeEditor: function(inSender, changed) {
		var self = this;
		if (changed && this.editing) {
			this.$.confirmDialog.ask("Discard your changes?",
				"\"" + this.editing.entry.n + "\" has changes that have not been saved.", "Discard", function() {
					self.leaveEditor();
				});
			return;
		}
		this.leaveEditor();
	},

	leaveEditor: function() {
		var saved = this.editing && this.editing.saved;
		this.editing = null;
		this.$.pane.selectViewByName("browse");
		this.$.editor.clear();
		if (saved) {
			// The file's size and date changed.
			this.load();
		}
	},

	// Show a picture, with the folder's other pictures either side of it.
	viewPicture: function(e) {
		var shown = this.$.files.getShown();
		var pictures = [];
		var at = 0;
		for (var i = 0; i < shown.length; i++) {
			if (FM.isPicture(shown[i])) {
				if (shown[i] === e) {
					at = pictures.length;
				}
				pictures.push(shown[i]);
			}
		}
		this.$.viewer.showPictures(pictures, at);
		this.$.pane.selectViewByName("viewer");
	},

	closeViewer: function() {
		this.$.pane.selectViewByName("browse");
		this.$.viewer.clear();
	},

	// ---- what the bars say ----

	showNav: function() {
		this.$.back.setDisabled(!this.backs.length);
		this.$.forward.setDisabled(!this.forwards.length);
		this.$.up.setDisabled(this.path === FM.ROOT);
	},

	// The path as folders to tap. A long path keeps its last few.
	showCrumbs: function() {
		var trail = FM.trail(this.path);
		var keep = 4;
		var from = Math.max(0, trail.length - keep);
		var c = this.$.crumbs;
		c.destroyControls();
		if (from > 0) {
			c.createComponent({content: "…", className: "fm-crumb", crumbPath: trail[from - 1].path,
				onclick: "crumbClick", owner: this});
			c.createComponent({className: "fm-crumb-gap"});
		}
		for (var i = from; i < trail.length; i++) {
			var last = i === trail.length - 1;
			c.createComponent({content: trail[i].name, className: "fm-crumb" + (last ? " fm-crumb-here" : ""),
				crumbPath: trail[i].path, onclick: "crumbClick", owner: this});
			if (!last) {
				c.createComponent({className: "fm-crumb-gap"});
			}
		}
		c.render();
	},

	showStatus: function() {
		var n = this.$.files.getCount();
		var text = FM.count(n, "item");
		if (this.free >= 0) {
			text += "  ·  " + FM.size(this.free) + " free";
		}
		if (!FM.inStorage(this.path)) {
			text += this.canChange() ? "  ·  System files: changes allowed" : "  ·  Read-only";
		}
		this.$.status.setContent(text);
	},

	// Captions that say what is chosen now.
	showChoices: function() {
		var names = {name: "Name", date: "Date", type: "Type", size: "Size"};
		this.$.viewBtn.setCaption(this.$.files.getView() === "icons" ? "Details" : "Icons");
		this.$.sortBtn.setCaption("Sort: " + names[this.$.files.getSortKey()]);
		this.$.hiddenItem.setCaption(this.hidden ? "Hide Hidden Files" : "Show Hidden Files");
		var canChange = this.canChange();
		this.$.systemItem.setCaption(this.system ? "Stop Allowing System Changes" : "Allow System Changes");
		// A red bar wherever a slip could harm the system.
		this.$.bar.addRemoveClass("fm-bottom-system", canChange && !FM.inStorage(this.path));
		this.$.selBar.addRemoveClass("fm-bottom-system", canChange && !FM.inStorage(this.path));
		this.$.newBtn.setShowing(canChange);
		this.$.paste.setShowing(!!this.clip && canChange);
		if (this.clip) {
			this.$.paste.setCaption("Paste (" + this.clip.paths.length + ")");
		}
	},

	toggleView: function() {
		var view = this.$.files.getView() === "icons" ? "details" : "icons";
		this.$.files.setView(view);
		FM.setPref("view", view);
		this.showChoices();
	},

	toggleTree: function() {
		this.treeShown = !this.treeShown;
		this.$.tree.setShowing(this.treeShown);
		FM.setPref("tree", this.treeShown ? "1" : "0");
		// Everything beside the tree has a new width.
		this.resized();
	},

	// Whether things in the folder shown may be changed. Outside the storage
	// they can be looked at and copied from; changing them takes the switch in
	// the app menu, and the live folders cannot be changed at all.
	canChange: function() {
		var path = this.path || FM.ROOT;
		return FM.inStorage(path) || (this.system && !FM.live(path));
	},

	toggleSystem: function() {
		var self = this;
		if (this.system) {
			this.setSystem(false);
			return;
		}
		this.$.confirmDialog.ask("Allow changes to system files?",
			"Topaz Explorer will be able to rename, move, replace and delete anything on this TouchPad, " +
			"including the files webOS needs to start. A mistake can leave the TouchPad unable to " +
			"start until it is restored with webOS Doctor. This stays on until you switch it off or close Topaz Explorer.",
			"Allow", function() {
				self.setSystem(true);
			});
	},

	setSystem: function(on) {
		var self = this;
		this.$.svc.ask("unlock", {on: on}, function(r) {
			if (!r.ok) {
				FM.banner(r.error);
			}
			// Switching off always takes effect here, even if the disk stayed open.
			self.system = on && r.ok;
			self.showChoices();
			self.showStatus();
			self.selectionChanged(self, self.$.files.getSelected().length);
			if (self.system) {
				FM.banner("System changes allowed");
			}
		});
	},

	toggleHidden: function() {
		this.hidden = !this.hidden;
		FM.setPref("hidden", this.hidden ? "1" : "0");
		this.$.files.setHidden(this.hidden);
		this.$.tree.setHidden(this.hidden);
		this.showChoices();
		this.showStatus();
	},

	sortClick: function() {
		this.$.sortMenu.openAroundControl(this.$.sortBtn);
	},

	sortMenuPicked: function(inSender) {
		var key = inSender.sortKey;
		var down = key === this.$.files.getSortKey() ? !this.$.files.getSortDown() : (key === "date" || key === "size");
		this.$.files.setSortKey(key);
		this.$.files.setSortDown(down);
		this.sortPicked(this, key, down);
	},

	sortPicked: function(inSender, key, down) {
		FM.setPref("sortKey", key);
		FM.setPref("sortDown", down ? "1" : "0");
		this.showChoices();
	},

	// ---- searching ----

	// Typing narrows the folder shown; "Search Subfolders" looks below it too.
	searchChanged: function() {
		var text = String(this.$.search.getValue() || "").replace(/^\s+|\s+$/g, "");
		if (text === this.searching) {
			return;
		}
		this.searching = text;
		if (this.deepShown) {
			this.deepShown = false;
			this.$.files.showFolder(this.entries);
		}
		this.$.files.setFilter(text);
		this.$.searchBar.setShowing(!!text);
		this.$.deep.show();
		this.$.searchNote.setContent("In this folder: names containing \"" + text + "\"");
		this.showStatus();
	},

	deepSearch: function() {
		var text = this.searching;
		var self = this;
		var path = this.path;
		if (!text) {
			return;
		}
		this.$.searchNote.setContent("Searching…");
		this.$.deep.hide();
		this.$.svc.ask("search", {path: path, text: text, hidden: this.hidden}, function(r) {
			if (path !== self.path || text !== self.searching) {
				return;
			}
			if (!r.ok) {
				self.$.searchNote.setContent(r.error);
				return;
			}
			for (var i = 0; i < r.entries.length; i++) {
				FM.dress(r.entries[i], r.entries[i].p);
			}
			self.deepShown = true;
			self.$.files.showResults(r.entries);
			self.$.searchNote.setContent((r.more ? "The first " + r.entries.length : FM.count(r.entries.length, "item")) +
				" containing \"" + text + "\" in " + FM.nameOf(path) + " and its subfolders");
			self.showStatus();
		});
	},

	// ---- selecting ----

	selectClick: function() {
		this.$.files.beginSelecting();
		this.selectionChanged(this, 0);
	},

	selectAllClick: function() {
		this.$.files.selectAll();
	},

	doneSelecting: function() {
		this.$.files.clearSelection();
	},

	selectionChanged: function(inSender, count) {
		var on = this.$.files.selecting;
		this.$.bar.setShowing(!on);
		this.$.selBar.setShowing(on);
		if (!on) {
			return;
		}
		var picked = this.$.files.getSelected();
		var bytes = 0;
		var folders = 0;
		for (var i = 0; i < picked.length; i++) {
			bytes += picked[i].s;
			folders += picked[i].d;
		}
		this.$.selStatus.setContent(count ? count + " selected" + (folders ? "" : "  ·  " + FM.size(bytes)) :
			"Tap what you want to select");
		this.$.copy.setDisabled(!count);
		var canChange = this.canChange();
		this.$.cut.setDisabled(!count || !canChange);
		this.$.del.setDisabled(!count || !canChange);
		this.$.more.setDisabled(!count);
		this.$.rename.setDisabled(count !== 1 || !canChange);
		this.$.pack.setDisabled(!canChange);
	},

	pickedPaths: function() {
		var picked = this.$.files.getSelected();
		var paths = [];
		for (var i = 0; i < picked.length; i++) {
			paths.push(picked[i].path);
		}
		return paths;
	},

	// ---- actions ----

	copyClick: function() {
		this.toClip("copy");
	},

	cutClick: function() {
		this.toClip("move");
	},

	toClip: function(op) {
		var paths = this.pickedPaths();
		if (!paths.length) {
			return;
		}
		this.clip = {op: op, paths: paths};
		this.doneSelecting();
		this.showChoices();
		FM.banner(FM.count(paths.length, "item") + (op === "copy" ? " to copy" : " to move") + ": go to a folder and tap Paste");
	},

	paste: function() {
		if (this.clip) {
			this.runJob(this.clip.op, this.clip.paths, this.path, "");
		}
	},

	newFolder: function() {
		var self = this;
		var path = this.path;
		this.$.nameDialog.ask("New Folder", "New folder", "Create", function(name) {
			self.$.svc.ask("mkdir", {path: path, name: name, system: self.system}, function(r) {
				if (!r.ok) {
					self.$.nameDialog.showProblem(r.error);
					return;
				}
				self.$.nameDialog.done();
				self.foldersChanged([path]);
			});
		});
	},

	renameClick: function() {
		var picked = this.$.files.getSelected();
		var self = this;
		if (picked.length !== 1) {
			return;
		}
		var e = picked[0];
		this.$.nameDialog.ask("Rename", e.n, "Rename", function(name) {
			self.$.svc.ask("rename", {path: e.path, name: name, system: self.system}, function(r) {
				if (!r.ok) {
					self.$.nameDialog.showProblem(r.error);
					return;
				}
				self.$.nameDialog.done();
				self.foldersChanged([FM.parentOf(e.path)]);
			});
		});
	},

	deleteClick: function() {
		var picked = this.$.files.getSelected();
		var paths = this.pickedPaths();
		var self = this;
		if (!paths.length) {
			return;
		}
		var what = paths.length === 1 ? "\"" + picked[0].n + "\"" : "these " + paths.length + " items";
		var folders = 0;
		for (var i = 0; i < picked.length; i++) {
			folders += picked[i].d;
		}
		this.$.confirmDialog.ask("Delete " + what + "?",
			(FM.inStorage(this.path) ? "" : "This is part of the system. ") + (folders ? "Everything inside " + (folders === 1 && paths.length === 1 ? "the folder" : "the folders") +
				" is deleted too. " : "") + "This cannot be undone.",
			"Delete", function() {
				self.runJob("delete", paths, "", "");
			});
	},

	detailsClick: function() {
		var picked = this.$.files.getSelected();
		var self = this;
		if (!picked.length) {
			return;
		}
		var one = picked.length === 1 ? picked[0] : null;
		var rows = [];
		rows.push(["Name", one ? one.n : FM.count(picked.length, "item")]);
		if (one) {
			rows.push(["Type", one.type]);
		}
		rows.push(["Location", FM.place(FM.parentOf(picked[0].path))]);
		rows.push(["Size", "Working it out…"]);
		if (one) {
			rows.push(["Modified", FM.when(one.m)]);
		}
		var sizeRow = one ? 3 : 2;
		this.$.detailsDialog.showRows(rows);
		this.$.svc.ask("details", {paths: this.pickedPaths()}, function(r) {
			if (!r.ok || !self.$.detailsDialog.isOpen) {
				return;
			}
			rows[sizeRow][1] = FM.size(r.bytes) + (r.bytes >= 1024 ? " (" + r.bytes + " bytes)" : "");
			if (r.folders) {
				// The folders counted include the selected ones themselves.
				var inner = r.folders - (one ? 1 : 0);
				rows.splice(sizeRow + 1, 0, ["Contains", FM.count(r.files, "file") + ", " + FM.count(inner, "folder")]);
			}
			self.$.detailsDialog.showRows(rows);
		});
	},

	// ---- jobs ----

	// Start a job (copy, move, delete, extract, pack), with the dialog for things
	// in the way and the progress dialog. extra: more for the service, such as
	// {folder} or {name}. started(error): told whether it began, instead of a banner.
	runJob: function(op, paths, dest, mode, extra, started) {
		var self = this;
		var params = {op: op, paths: paths, dest: dest, mode: mode, system: this.system};
		for (var k in (extra || {})) {
			if (extra.hasOwnProperty(k)) {
				params[k] = extra[k];
			}
		}
		this.$.svc.ask("start", params, function(r) {
			if (!r.ok) {
				if (started) {
					started(r.error);
				} else {
					FM.banner(r.error);
				}
				return;
			}
			if (started) {
				started("");
			}
			if (r.conflicts) {
				self.$.conflictDialog.ask(r.conflicts, function(picked) {
					self.runJob(op, paths, dest, picked, extra);
				});
				return;
			}
			var job = {op: op, paths: paths, dest: dest, extra: extra || {}, shown: false};
			self.job = job;
			self.doneSelecting();
			// The dialog comes up unless the job is over almost at once.
			setTimeout(function() {
				if (self.job === job && !job.shown) {
					job.shown = true;
					self.$.progressDialog.begin({copy: "Copying", move: "Moving", "delete": "Deleting",
						extract: "Extracting", pack: "Compressing"}[op]);
				}
			}, 400);
			self.watchJob();
		});
	},

	watchJob: function() {
		var self = this;
		var job = this.job;
		this.$.svc.ask("status", {}, function(s) {
			if (!job || job !== self.job) {
				return;
			}
			if (s.ok && s.running) {
				if (job.shown) {
					self.$.progressDialog.showStatus(s);
				}
				setTimeout(function() {
					self.watchJob();
				}, 300);
				return;
			}
			self.job = null;
			if (job.shown) {
				self.$.progressDialog.close();
			}
			self.jobDone(job, s);
		});
	},

	cancelJob: function() {
		this.$.svc.ask("cancel", {}, function() {});
	},

	jobDone: function(job, s) {
		var did = {copy: "copied", move: "moved", "delete": "deleted", extract: "extracted", pack: "compressed"}[job.op];
		var self = this;
		if (s.ok && s.password) {
			// Ask for the password and try again with it.
			this.$.nameDialog.ask(job.extra.password ? "Wrong password; try again" : "Password for this archive", "", "Extract", function(word) {
				self.$.nameDialog.done();
				self.runJob(job.op, job.paths, job.dest, "", {folder: job.extra.folder, password: word});
			});
		} else if (s.ok && s.note) {
			FM.banner(s.note);
		} else if (!s.ok) {
			FM.banner("Topaz Explorer lost touch with its helper; check what was " + did);
		} else if (s.failed) {
			FM.banner(FM.count(s.failed, "item") + " could not be " + did + (s.firstError ? ", \"" + s.firstError + "\" among them" : ""));
		} else if (s.cancelled) {
			FM.banner("Stopped: " + s.doneThings + " of " + FM.count(s.things || s.items, "item") + " " + did);
		} else {
			// Say so when it is done, however quick it was.
			FM.banner(FM.count(s.things || s.items, "item") + " " + did);
		}
		if (job.op === "move" && this.clip && !s.cancelled) {
			this.clip = null;
		}
		var touched = [];
		var seen = {};
		function add(p) {
			if (p && !seen[p]) {
				seen[p] = true;
				touched.push(p);
			}
		}
		add(job.dest);
		if (job.op !== "copy") {
			for (var i = 0; i < job.paths.length; i++) {
				add(FM.parentOf(job.paths[i]));
			}
		}
		this.showChoices();
		this.foldersChanged(touched);
	},

	// Folders whose contents changed: show them afresh.
	foldersChanged: function(folders) {
		for (var i = 0; i < folders.length; i++) {
			this.$.tree.reload(folders[i]);
		}
		this.load();
	}
});
