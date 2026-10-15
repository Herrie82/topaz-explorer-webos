/* What is in a folder, as a details list or as icons. Tap opens, holding
	selects; once something is selected, taps add to or take from the selection. */

FM.MAX_COLS = 10;        // icon columns the widest screen can hold
FM.CELL_WIDTH = 124;     // matches .fm-cell
FM.HOLD_MS = 350;        // how long a touch must rest to select

// The cells of one row of icons.
FM.cells = function() {
	var out = [];
	for (var i = 0; i < FM.MAX_COLS; i++) {
		out.push({name: "cell" + i, className: "fm-cell", cellIndex: i, onclick: "cellClick", components: [
			{name: "cellIcon" + i, className: "fm-big-icon", components: [
				{name: "cellTag" + i, className: "fm-tag"}
			]},
			{name: "cellName" + i, className: "fm-cell-name"}
		]});
	}
	return out;
};

enyo.kind({
	name: "FM.FileView",
	kind: enyo.VFlexBox,
	className: "fm-files",
	published: {
		view: "details",     // or "icons"
		sortKey: "name",     // name, date, type, size
		sortDown: false,
		filter: "",          // only names containing this
		hidden: false        // show names starting with a dot
	},
	events: {
		// A file or folder was tapped: (entry)
		onOpen: "",
		// The selection changed: (count)
		onSelection: "",
		// A column heading was tapped: (key, down)
		onSort: ""
	},
	components: [
		{name: "note", className: "fm-note", showing: false},
		{name: "views", kind: "Pane", flex: 1, transitionKind: "enyo.transitions.Simple", components: [
			{name: "details", kind: "VFlexBox", components: [
				{name: "heads", kind: "HFlexBox", align: "center", className: "fm-heads", components: [
					{name: "headName", flex: 1, className: "fm-head", sortKey: "name", onclick: "headClick", components: [
						{content: "Name", className: "fm-head-text"}, {name: "markName", className: "fm-sort-mark"}
					]},
					{name: "headDate", className: "fm-head fm-col-date", sortKey: "date", onclick: "headClick", components: [
						{content: "Date modified", className: "fm-head-text"}, {name: "markDate", className: "fm-sort-mark"}
					]},
					{name: "headType", className: "fm-head fm-col-type", sortKey: "type", onclick: "headClick", components: [
						{content: "Type", className: "fm-head-text"}, {name: "markType", className: "fm-sort-mark"}
					]},
					{name: "headSize", className: "fm-head fm-col-size", sortKey: "size", onclick: "headClick", components: [
						{content: "Size", className: "fm-head-text"}, {name: "markSize", className: "fm-sort-mark"}
					]}
				]},
				{name: "list", kind: "VirtualList", flex: 1, onSetupRow: "setupRow", components: [
					{name: "row", kind: "Item", layoutKind: "HFlexLayout", align: "center", tapHighlight: true,
						className: "fm-row", onclick: "rowClick", components: [
							{name: "check", className: "fm-check"},
							{name: "icon", className: "fm-icon", components: [
								{name: "tag", className: "fm-tag"}
							]},
							{kind: "VFlexBox", flex: 1, className: "fm-name-box", components: [
								{name: "name", className: "fm-name"},
								{name: "where", className: "fm-where"}
							]},
							{name: "date", className: "fm-col fm-col-date"},
							{name: "type", className: "fm-col fm-col-type"},
							{name: "size", className: "fm-col fm-col-size"}
						]}
				]}
			]},
			{name: "grid", kind: "VirtualList", onSetupRow: "setupGridRow", components: [
				{name: "gridRow", kind: "HFlexBox", className: "fm-grid-row", components: FM.cells()}
			]}
		]}
	],

	create: function() {
		this.inherited(arguments);
		this.all = [];           // everything in the folder (or found by a search)
		this.shown = [];         // after the filter, in order
		this.results = false;    // showing search results from several folders
		this.selecting = false;
		this.cols = 6;
		this.emptyText = "This folder is empty.";
	},

	rendered: function() {
		this.inherited(arguments);
		this.viewChanged();
		this.markSort();
	},

	// ---- for the app ----

	showFolder: function(entries) {
		this.results = false;
		this.emptyText = "This folder is empty.";
		this.all = entries;
		this.selecting = false;
		this.arrange(true);
		this.doSelection(0);
	},

	showResults: function(entries) {
		this.results = true;
		this.emptyText = "Nothing was found.";
		this.all = entries;
		this.selecting = false;
		this.arrange(true);
		this.doSelection(0);
	},

	showNote: function(text) {
		this.$.note.setContent(text);
		this.$.note.setShowing(!!text);
	},

	getSelected: function() {
		var out = [];
		for (var i = 0; i < this.shown.length; i++) {
			if (this.shown[i].sel) {
				out.push(this.shown[i]);
			}
		}
		return out;
	},

	// What is shown, in the order shown.
	getShown: function() {
		return this.shown;
	},

	getCount: function() {
		return this.shown.length;
	},

	selectAll: function() {
		for (var i = 0; i < this.shown.length; i++) {
			this.shown[i].sel = true;
		}
		this.selecting = this.shown.length > 0;
		this.selectionChanged();
	},

	// Start choosing things with nothing chosen yet.
	beginSelecting: function() {
		this.selecting = true;
		this.redraw();
	},

	clearSelection: function() {
		for (var i = 0; i < this.all.length; i++) {
			this.all[i].sel = false;
		}
		this.selecting = false;
		this.redraw();
		this.doSelection(0);
	},

	viewChanged: function() {
		this.$.views.selectViewByName(this.view === "icons" ? "grid" : "details");
		this.measureCols();
		this.redraw(true);
	},

	sortKeyChanged: function() {
		this.markSort();
		this.arrange(true);
	},

	sortDownChanged: function() {
		this.markSort();
		this.arrange(true);
	},

	filterChanged: function() {
		this.arrange(true);
	},

	hiddenChanged: function() {
		this.arrange(true);
	},

	// ---- arranging ----

	// Apply the filter and the sort order to what is shown.
	arrange: function(toTop) {
		var words = String(this.filter || "").toLowerCase();
		var out = [];
		for (var i = 0; i < this.all.length; i++) {
			var e = this.all[i];
			if ((this.hidden || e.n.charAt(0) !== ".") && (!words || this.results || e.key.indexOf(words) >= 0)) {
				out.push(e);
			} else {
				e.sel = false;
			}
		}
		var key = this.sortKey;
		var sign = this.sortDown ? -1 : 1;
		out.sort(function(a, b) {
			// Folders stay together above the files, as in Explorer.
			if (a.d !== b.d) {
				return b.d - a.d;
			}
			var r = 0;
			if (key === "date") {
				r = a.m - b.m;
			} else if (key === "size") {
				r = a.s - b.s;
			} else if (key === "type") {
				r = a.type < b.type ? -1 : (a.type > b.type ? 1 : 0);
			}
			return (r || FM.natural(a.key, b.key)) * sign;
		});
		this.shown = out;
		this.showNote(out.length ? "" : (this.all.length && words ? "Nothing in this folder matches." : this.emptyText));
		this.redraw(toTop);
	},

	markSort: function() {
		var marks = {name: this.$.markName, date: this.$.markDate, type: this.$.markType, size: this.$.markSize};
		for (var k in marks) {
			if (marks.hasOwnProperty(k)) {
				marks[k].setClassName("fm-sort-mark" + (k === this.sortKey ? (this.sortDown ? " fm-sort-down" : " fm-sort-up") : ""));
			}
		}
	},

	headClick: function(inSender) {
		var key = inSender.sortKey;
		// A second tap on the same heading turns the order round.
		var down = key === this.sortKey ? !this.sortDown : (key === "date" || key === "size");
		this.sortKey = key;
		this.sortDown = down;
		this.markSort();
		this.arrange(true);
		this.doSort(key, down);
	},

	// ---- drawing ----

	measureCols: function() {
		var node = this.hasNode();
		var width = node ? node.clientWidth : 0;
		if (width) {
			this.cols = Math.max(1, Math.min(FM.MAX_COLS, Math.floor(width / FM.CELL_WIDTH)));
			// Too narrow for every column: the type goes first.
			this.addRemoveClass("fm-narrow", width < 640);
			// A phone standing up: the date goes too, so the name keeps its room.
			this.addRemoveClass("fm-tight", width < 400);
		}
	},

	resizeHandler: function() {
		this.inherited(arguments);
		var before = this.cols;
		this.measureCols();
		if (before !== this.cols && this.view === "icons") {
			this.redraw(true);
		}
	},

	// Draw the rows again; toTop also goes back to the first row.
	redraw: function(toTop) {
		var list = this.view === "icons" ? this.$.grid : this.$.list;
		if (!list.hasNode()) {
			return;
		}
		if (toTop) {
			list.punt();
		} else {
			list.refresh();
		}
	},

	setupRow: function(inSender, inIndex) {
		var e = this.shown[inIndex];
		if (!e) {
			return false;
		}
		// The row's controls are reused for every row, so each one sets all of this.
		this.$.row.addRemoveClass("fm-selected", e.sel);
		this.$.check.setShowing(this.selecting);
		this.$.check.setClassName("fm-check" + (e.sel ? " fm-check-on" : ""));
		this.$.icon.setClassName("fm-icon " + (e.d ? "fm-icon-folder" : "fm-icon-file"));
		this.$.tag.setShowing(!!e.tag);
		this.$.tag.setClassName("fm-tag fm-tag-" + e.family);
		this.$.tag.setContent(e.tag);
		this.$.name.setContent(e.n);
		this.$.where.setShowing(this.results);
		this.$.where.setContent(this.results ? FM.place(e.p) : "");
		this.$.date.setContent(FM.when(e.m));
		this.$.type.setContent(e.type);
		this.$.size.setContent(e.d ? "" : FM.size(e.s));
		return true;
	},

	setupGridRow: function(inSender, inIndex) {
		var first = inIndex * this.cols;
		if (inIndex < 0 || first >= this.shown.length) {
			return false;
		}
		for (var i = 0; i < FM.MAX_COLS; i++) {
			var e = i < this.cols ? this.shown[first + i] : null;
			var cell = this.$["cell" + i];
			var icon = this.$["cellIcon" + i];
			var tag = this.$["cellTag" + i];
			cell.setShowing(i < this.cols);
			cell.setClassName("fm-cell" + (e ? (e.sel ? " fm-selected" : "") : " fm-cell-empty"));
			if (!e) {
				continue;
			}
			// Photos show themselves; everything else shows its kind.
			var picture = FM.isPicture(e);
			icon.setClassName("fm-big-icon " + (e.d ? "fm-icon-folder" : (picture ? "fm-icon-picture" : "fm-icon-file")));
			icon.applyStyle("background-image", picture ? FM.thumbUrl(e.path, 64) : null);
			tag.setShowing(!!e.tag && !picture);
			tag.setClassName("fm-tag fm-tag-" + e.family);
			tag.setContent(e.tag);
			this.$["cellName" + i].setContent(e.n);
		}
		return true;
	},

	// ---- touches ----

	// Which entry an event landed on, or -1.
	indexFromEvent: function(inEvent) {
		if (inEvent.rowIndex === undefined || inEvent.rowIndex === null) {
			return -1;
		}
		if (this.view !== "icons") {
			return inEvent.rowIndex < this.shown.length ? inEvent.rowIndex : -1;
		}
		var c = inEvent.dispatchTarget;
		while (c && c !== this) {
			if (c.cellIndex !== undefined) {
				var i = inEvent.rowIndex * this.cols + c.cellIndex;
				return (c.cellIndex < this.cols && i < this.shown.length) ? i : -1;
			}
			c = c.parent;
		}
		return -1;
	},

	// A touch that rests on something selects it.
	mouseholdpulseHandler: function(inSender, inEvent) {
		if (!inEvent || inEvent.holdTime < FM.HOLD_MS || this.heldStart === inEvent.holdStart) {
			return;
		}
		var i = this.indexFromEvent(inEvent);
		if (i < 0) {
			return;
		}
		this.heldStart = inEvent.holdStart;
		// The tap that follows lifting the finger is part of this hold.
		this.swallowTap = true;
		this.shown[i].sel = true;
		this.selecting = true;
		this.selectionChanged();
	},

	mousereleaseHandler: function() {
		if (this.swallowTap) {
			var self = this;
			setTimeout(function() {
				self.swallowTap = false;
			}, 350);
		}
	},

	rowClick: function(inSender, inEvent) {
		this.tapped(inEvent.rowIndex);
	},

	cellClick: function(inSender, inEvent) {
		if (inSender.cellIndex < this.cols) {
			this.tapped(inEvent.rowIndex * this.cols + inSender.cellIndex);
		}
	},

	tapped: function(index) {
		var e = this.shown[index];
		if (!e || this.swallowTap) {
			return;
		}
		if (this.selecting) {
			e.sel = !e.sel;
			this.selectionChanged();
		} else {
			this.doOpen(e);
		}
	},

	selectionChanged: function() {
		var n = this.getSelected().length;
		this.redraw();
		this.doSelection(n);
	}
});
