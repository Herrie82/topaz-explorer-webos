/* The folder tree on the left: Favorites, when there are any, then the
	device's storage and, below it, the whole system; every folder, opened level
	by level. Only the rows on screen exist; the tree itself is kept as plain
	data. */
enyo.kind({
	name: "FM.Tree",
	kind: enyo.VFlexBox,
	className: "fm-tree",
	published: {
		// Show folders whose names start with a dot.
		hidden: false
	},
	events: {
		// A folder was tapped: (path)
		onPick: "",
		// A favorite was held, to rename or remove it: (path)
		onFavoriteHold: ""
	},
	components: [
		{name: "svc", kind: "FM.Service"},
		{name: "list", kind: "VirtualList", flex: 1, onSetupRow: "setupRow", components: [
			{name: "row", kind: "Item", layoutKind: "HFlexLayout", align: "center", tapHighlight: true,
				className: "fm-tree-row", onclick: "rowClick", components: [
					{name: "indent"},
					{name: "arrowBox", className: "fm-arrow-box", onclick: "arrowClick", components: [
						{name: "arrow", className: "fm-arrow"}
					]},
					{name: "icon", className: "fm-tree-icon"},
					{name: "name", flex: 1, className: "fm-tree-name"}
				]}
		]}
	],

	create: function() {
		this.inherited(arguments);
		// A node: {path, name, depth, open, kids: [nodes] or null until read, hasKids}
		this.roots = [
			{path: FM.ROOT, name: FM.ROOT_NAME, depth: 0, open: false, kids: null, hasKids: true},
			{path: FM.SYSTEM, name: FM.SYSTEM_NAME, depth: 0, open: false, kids: null, hasKids: true}
		];
		// The Favorites heading and the places under it (FM.favorites).
		this.favHead = {name: "Favorites", depth: 0, open: true, head: true, hasKids: true};
		this.favs = [];
		this.rows = this.roots.slice(0);
		this.current = "";
		this.setFavorites(FM.favorites());
	},

	// The places to show under Favorites: [{name, path}].
	setFavorites: function(list) {
		this.favs = [];
		for (var i = 0; i < list.length; i++) {
			this.favs.push({path: list[i].path, name: list[i].name, depth: 1, fav: true, hasKids: false});
		}
		this.flatten();
	},

	// The storage's name changed (FM.setDeviceName): show the new one.
	renameRoot: function() {
		this.roots[0].name = FM.ROOT_NAME;
		this.flatten();
	},

	hiddenChanged: function() {
		this.flatten();
	},

	// ---- data ----

	// Read a node's folders, keeping what was open below it. done() when read.
	readNode: function(node, done) {
		var self = this;
		this.$.svc.ask("list", {path: node.path, folders: true, kids: true}, function(r) {
			if (!r.ok) {
				node.kids = node.kids || [];
				node.hasKids = node.kids.length > 0;
				if (done) {
					done();
				}
				return;
			}
			var old = {};
			var i;
			for (i = 0; node.kids && i < node.kids.length; i++) {
				old[node.kids[i].name] = node.kids[i];
			}
			var kids = [];
			for (i = 0; i < r.entries.length; i++) {
				var e = r.entries[i];
				var was = old[e.n];
				kids.push({
					path: FM.join(node.path, e.n), name: e.n, depth: node.depth + 1, key: e.n.toLowerCase(),
					open: was ? was.open : false, kids: was ? was.kids : null, hasKids: !!e.k
				});
			}
			kids.sort(function(a, b) {
				return FM.natural(a.key, b.key);
			});
			node.kids = kids;
			node.hasKids = kids.length > 0;
			if (done) {
				done();
			}
		});
	},

	// The node for a path, if that part of the tree has been read.
	find: function(path) {
		var trail = FM.trail(path);
		var node = this.roots[trail[0].path === FM.ROOT ? 0 : 1];
		for (var i = 1; i < trail.length && node; i++) {
			var next = null;
			for (var k = 0; node.kids && k < node.kids.length; k++) {
				if (node.kids[k].path === trail[i].path) {
					next = node.kids[k];
					break;
				}
			}
			node = next;
		}
		return node;
	},

	// Rebuild the list of rows from the open nodes.
	flatten: function() {
		var rows = [];
		var hidden = this.hidden;
		function add(node) {
			rows.push(node);
			if (node.open && node.kids) {
				for (var i = 0; i < node.kids.length; i++) {
					if (hidden || node.kids[i].name.charAt(0) !== ".") {
						add(node.kids[i]);
					}
				}
			}
		}
		if (this.favs.length) {
			rows.push(this.favHead);
			if (this.favHead.open) {
				rows.push.apply(rows, this.favs);
			}
		}
		add(this.roots[0]);
		add(this.roots[1]);
		this.rows = rows;
		if (this.$.list.hasNode()) {
			this.$.list.refresh();
		}
	},

	// ---- for the app ----

	// Mark a folder as the one being shown, opening the tree down to it.
	reveal: function(path) {
		this.current = path;
		if (FM.isNet(path)) {
			// Sites are not in the tree; a favorite may be.
			this.flatten();
			return;
		}
		var trail = FM.trail(path);
		var self = this;
		var at = 0;
		if (!this.begun) {
			// The storage starts open, whichever folder is shown first.
			this.begun = true;
			this.roots[0].open = true;
			this.readNode(this.roots[0], function() {
				self.reveal(self.current);
			});
			return;
		}
		function step() {
			// Open every folder above the one shown; the one shown stays as it is.
			if (at >= trail.length - 1) {
				self.flatten();
				return;
			}
			var node = self.find(trail[at].path);
			at++;
			if (!node) {
				self.flatten();
				return;
			}
			node.open = true;
			if (node.kids) {
				step();
			} else {
				self.readNode(node, step);
			}
		}
		step();
	},

	// A folder's contents changed: read its folders again if they are in the tree.
	reload: function(path) {
		if (FM.isNet(path)) {
			return;
		}
		var node = this.find(path);
		var self = this;
		if (node && node.kids) {
			this.readNode(node, function() {
				self.flatten();
			});
		} else if (node) {
			// Not read yet; it may have gained its first folder.
			node.hasKids = true;
			this.flatten();
		}
	},

	// ---- rows ----

	setupRow: function(inSender, inIndex) {
		var node = this.rows[inIndex];
		if (!node) {
			return false;
		}
		this.$.row.addRemoveClass("fm-tree-current", node.path === this.current);
		this.$.indent.applyStyle("width", (node.depth * 18) + "px");
		this.$.arrow.setClassName("fm-arrow" + (node.hasKids ? (node.open ? " fm-arrow-open" : " fm-arrow-shut") : ""));
		var icon = "";
		if (node.head) {
			icon = " fm-tree-icon-star";
		} else if (node.fav) {
			icon = FM.isNet(node.path) ? " fm-tree-icon-net" : "";
		} else if (node.depth === 0) {
			icon = node.path === FM.ROOT ? " fm-tree-icon-device" : " fm-tree-icon-system";
		}
		this.$.icon.setClassName("fm-tree-icon" + icon);
		this.$.name.setContent(node.name);
		return true;
	},

	toggle: function(node) {
		var self = this;
		if (node.open || node.head) {
			node.open = !node.open;
			this.flatten();
		} else if (node.kids) {
			node.open = true;
			this.flatten();
		} else {
			node.open = true;
			this.readNode(node, function() {
				self.flatten();
			});
		}
	},

	arrowClick: function(inSender, inEvent) {
		var node = this.rows[inEvent.rowIndex];
		if (node && node.hasKids) {
			this.toggle(node);
		}
		// Handled here: the row itself is not tapped.
		return true;
	},

	// A touch that rests on a favorite offers to rename or remove it.
	mouseholdpulseHandler: function(inSender, inEvent) {
		if (!inEvent || inEvent.holdTime < FM.HOLD_MS || this.heldStart === inEvent.holdStart) {
			return;
		}
		var node = this.rows[inEvent.rowIndex];
		if (!node || !node.fav) {
			return;
		}
		this.heldStart = inEvent.holdStart;
		// The tap that follows lifting the finger is part of this hold.
		this.swallowTap = true;
		this.doFavoriteHold(node.path);
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
		var node = this.rows[inEvent.rowIndex];
		if (this.swallowTap) {
			this.swallowTap = false;
			return;
		}
		if (!node) {
			return;
		}
		if (node.head) {
			// The Favorites heading opens and closes.
			this.toggle(node);
			return;
		}
		if (node.path === this.current && node.hasKids) {
			// A second tap on the folder being shown opens or closes it.
			this.toggle(node);
			return;
		}
		this.doPick(node.path);
	}
});
