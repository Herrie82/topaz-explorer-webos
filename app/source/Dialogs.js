/* The dialogs: a name, a yes-or-no question, what to do about things in the
	way, progress, and details. Each is opened with a callback for the answer. */

// Ask for a name: ask(title, value, okCaption, callback(name)).
// The dialog stays open until done() is called, so a refused name can be fixed.
enyo.kind({
	name: "FM.NameDialog",
	kind: enyo.ModalDialog,
	lazy: false,
	components: [
		{name: "input", kind: "Input", autoCapitalize: "lowercase", autocorrect: false, spellcheck: false,
			onkeydown: "keyDown"},
		{name: "problem", className: "fm-dialog-problem", showing: false},
		{kind: "HFlexBox", className: "fm-dialog-buttons", components: [
			{kind: "Button", caption: "Cancel", flex: 1, onclick: "cancelClick"},
			{name: "ok", kind: "Button", caption: "OK", flex: 1, className: "enyo-button-affirmative", onclick: "okClick"}
		]}
	],

	ask: function(title, value, okCaption, callback) {
		this.callback = callback;
		this.setCaption(title);
		this.$.ok.setCaption(okCaption);
		this.$.input.setValue(value);
		this.showProblem("");
		this.openAtCenter();
		enyo.asyncMethod(this.$.input, "forceFocusEnableKeyboard");
	},

	showProblem: function(text) {
		this.$.problem.setContent(text);
		this.$.problem.setShowing(!!text);
	},

	done: function() {
		this.close();
	},

	keyDown: function(inSender, inEvent) {
		if (inEvent.keyCode === 13) {
			this.okClick();
		}
	},

	okClick: function() {
		var name = String(this.$.input.getValue() || "").replace(/^\s+|\s+$/g, "");
		if (!name) {
			this.showProblem("Type a name first.");
			return;
		}
		this.callback(name);
	},

	cancelClick: function() {
		this.close();
	}
});

// A question: ask(title, message, okCaption, callback()). The callback runs only on yes.
enyo.kind({
	name: "FM.ConfirmDialog",
	kind: enyo.ModalDialog,
	lazy: false,
	components: [
		{name: "message", className: "fm-dialog-text"},
		{kind: "HFlexBox", className: "fm-dialog-buttons", components: [
			{kind: "Button", caption: "Cancel", flex: 1, onclick: "cancelClick"},
			{name: "ok", kind: "Button", caption: "OK", flex: 1, className: "enyo-button-negative", onclick: "okClick"}
		]}
	],

	ask: function(title, message, okCaption, callback) {
		this.callback = callback;
		this.setCaption(title);
		this.$.message.setContent(message);
		this.$.ok.setCaption(okCaption);
		this.openAtCenter();
	},

	okClick: function() {
		this.close();
		this.callback();
	},

	cancelClick: function() {
		this.close();
	}
});

// Things with the same names are already there: ask(names, callback(mode)),
// mode being "replace", "skip" or "both".
enyo.kind({
	name: "FM.ConflictDialog",
	kind: enyo.ModalDialog,
	lazy: false,
	caption: "Already here",
	components: [
		{name: "message", className: "fm-dialog-text"},
		{kind: "Button", caption: "Replace", className: "enyo-button-negative", mode: "replace", onclick: "picked"},
		{kind: "Button", caption: "Skip These", mode: "skip", onclick: "picked"},
		{kind: "Button", caption: "Keep Both", mode: "both", onclick: "picked"},
		{kind: "Button", caption: "Cancel", onclick: "cancelClick"}
	],

	ask: function(names, callback) {
		this.callback = callback;
		this.$.message.setContent(names.length === 1 ?
			"This folder already has \"" + names[0] + "\"." :
			"This folder already has " + names.length + " of these, \"" + names[0] + "\" among them.");
		this.openAtCenter();
	},

	picked: function(inSender) {
		this.close();
		this.callback(inSender.mode);
	},

	cancelClick: function() {
		this.close();
	}
});

// A job at work: begin(title), showStatus(status from the service), close().
enyo.kind({
	name: "FM.ProgressDialog",
	kind: enyo.ModalDialog,
	lazy: false,
	events: {
		onCancel: ""
	},
	components: [
		{name: "what", className: "fm-dialog-text fm-one-line"},
		{name: "bar", kind: "ProgressBar", animatePosition: false},
		{name: "how", className: "fm-dialog-small"},
		{kind: "HFlexBox", className: "fm-dialog-buttons", components: [
			{name: "cancel", kind: "Button", caption: "Cancel", flex: 1, onclick: "cancelClick"}
		]}
	],

	begin: function(title) {
		this.setCaption(title);
		this.$.what.setContent("Getting ready…");
		this.$.how.setContent("");
		this.$.bar.setPosition(0);
		this.$.cancel.setDisabled(false);
		this.openAtCenter();
	},

	showStatus: function(s) {
		if (s.stage === "counting") {
			this.$.what.setContent("Getting ready…");
			this.$.how.setContent(s.things ? FM.count(s.things, "item") + " so far" : "");
			return;
		}
		// Archives: compressing follows the new file's growing size, extracting
		// counts files as they come out. Both move in real time; show how far
		// along and roughly how long is left (compressing can be slow).
		if (s.op === "pack" || s.op === "extract") {
			var frac = (s.bytes && s.doneBytes) ? s.doneBytes / s.bytes :
				(s.things ? s.doneThings / s.things : 0);
			this.$.bar.setPosition(Math.max(0, Math.min(100, Math.round(frac * 100))));
			this.$.what.setContent(s.current || "…");
			// Compressing follows the archive's size (the file count lags behind,
			// so leading with it would look stuck); extracting counts files.
			var line;
			if (s.op === "pack" && s.bytes) {
				line = FM.size(s.doneBytes) + " of " + FM.size(s.bytes);
			} else {
				line = s.things ? s.doneThings + " of " + FM.count(s.things, "item") :
					(s.doneThings ? FM.count(s.doneThings, "item") + " so far" : "working…");
			}
			var left = this.timeLeft(s, frac);
			if (left) {
				line += "  ·  " + left;
			}
			this.$.how.setContent(line);
			return;
		}
		// By size where sizes are known (a copy), else by how many things are done.
		if (!s.things && s.doneThings) {
			// An archive whose size is not known until it has been gone through.
			this.$.what.setContent(s.current || "…");
			this.$.how.setContent(FM.count(s.doneThings, "item") + " so far");
			return;
		}
		var part = s.op === "copy" && s.bytes ? s.doneBytes / s.bytes :
			(s.things ? s.doneThings / s.things : (s.items ? s.doneItems / s.items : 0));
		this.$.bar.setPosition(Math.max(0, Math.min(100, Math.round(part * 100))));
		this.$.what.setContent(s.current || "…");
		var how = s.things ? s.doneThings + " of " + FM.count(s.things, "item") : s.doneItems + " of " + s.items;
		if (s.op === "copy" && s.bytes) {
			how += "  ·  " + FM.size(s.doneBytes) + " of " + FM.size(s.bytes);
		}
		this.$.how.setContent(how);
	},

	// How much longer, from how far along (0-1) and the time spent so far.
	timeLeft: function(s, frac) {
		if (!s.started || !frac || frac < 0.03) {
			return "";
		}
		var elapsed = new Date().getTime() - s.started;
		if (elapsed < 2000) {
			return "";
		}
		return FM.duration(elapsed * (1 - frac) / frac) + " left";
	},

	cancelClick: function() {
		this.$.cancel.setDisabled(true);
		this.$.what.setContent("Stopping…");
		this.doCancel();
	}
});

// Details of what is selected: show(rows), each [label, value].
enyo.kind({
	name: "FM.DetailsDialog",
	kind: enyo.ModalDialog,
	lazy: false,
	caption: "Details",
	components: [
		{name: "rows"},
		{kind: "HFlexBox", className: "fm-dialog-buttons", components: [
			{kind: "Button", caption: "Done", flex: 1, onclick: "doneClick"}
		]}
	],

	showRows: function(rows) {
		this.$.rows.destroyControls();
		for (var i = 0; i < rows.length; i++) {
			this.$.rows.createComponent({kind: "HFlexBox", className: "fm-detail", components: [
				{content: rows[i][0], className: "fm-detail-label"},
				{content: rows[i][1], flex: 1, className: "fm-detail-value"}
			]});
		}
		if (this.$.rows.hasNode()) {
			this.$.rows.render();
		}
		if (!this.isOpen) {
			this.openAtCenter();
		}
	},

	doneClick: function() {
		this.close();
	}
});
