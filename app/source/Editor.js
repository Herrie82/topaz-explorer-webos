/* The text editor: a plain text file, shown whole and saved as it was found
	(same line endings, same character set). */

// A plain multi-line text box that grows to hold its text, so the scroller
// around it does the scrolling. (This web engine cannot scroll inside a text
// box by touch.)
enyo.kind({
	name: "FM.TextBox",
	kind: enyo.Control,
	nodeTag: "textarea",
	className: "fm-editor-text",
	// Let touches reach the box itself, so it can take the cursor.
	requiresDomMousedown: true,
	requiresNodeFocus: true,
	events: {
		// The text was changed by the person.
		onEdit: ""
	},

	create: function() {
		this.inherited(arguments);
		this.domAttributes.spellcheck = "false";
		this.domAttributes.autocorrect = "off";
		this.domAttributes.autocapitalize = "off";
		this.domAttributes["x-palm-disable-auto-cap"] = "true";
		this.text = "";
		this.readOnly = false;
	},

	rendered: function() {
		this.inherited(arguments);
		var node = this.hasNode();
		if (node && node !== this.wired) {
			this.wired = node;
			node.addEventListener("input", enyo.bind(this, "edited"), false);
			node.value = this.text;
			node.readOnly = this.readOnly;
			this.fit();
		}
	},

	setText: function(text, readOnly) {
		this.text = text;
		this.readOnly = !!readOnly;
		var node = this.hasNode();
		if (node) {
			node.value = text;
			node.readOnly = this.readOnly;
			this.fit();
		}
	},

	getText: function() {
		var node = this.hasNode();
		return node ? node.value : this.text;
	},

	edited: function() {
		this.doEdit();
		// Measuring a long text is slow; wait for a pause in the typing.
		enyo.job(this.id + "-fit", enyo.bind(this, "fit"), 400);
	},

	// Make the box as tall as its text.
	fit: function() {
		var node = this.hasNode();
		if (node) {
			node.style.height = "auto";
			node.style.height = (node.scrollHeight + 40) + "px";
		}
	}
});

enyo.kind({
	name: "FM.Editor",
	kind: enyo.VFlexBox,
	className: "fm-editor",
	events: {
		// Back was tapped: (changed)
		onClose: "",
		// Save was tapped: (text)
		onSave: ""
	},
	components: [
		{kind: "HFlexBox", align: "center", className: "fm-top", components: [
			{kind: "Button", caption: "Back", className: "enyo-button-dark", onclick: "backClick"},
			{name: "title", flex: 1, className: "fm-viewer-title"},
			{name: "state", className: "fm-viewer-count"},
			{name: "save", kind: "Button", caption: "Save", className: "enyo-button-affirmative", onclick: "saveClick"}
		]},
		// accelerated: false, so a long text never becomes one large graphics layer.
		{name: "scroller", kind: "Scroller", flex: 1, accelerated: false, horizontal: false, autoHorizontal: false,
			className: "fm-editor-page", components: [
				{name: "text", kind: "FM.TextBox", onEdit: "textEdited"}
			]}
	],

	// Show a file's text: (name, text, whether it may be saved)
	openText: function(name, text, canSave) {
		this.canSave = canSave;
		this.changed = false;
		this.$.title.setContent(name);
		this.$.save.setShowing(canSave);
		this.$.text.setText(text, !canSave);
		this.$.scroller.setScrollTop(0);
		this.showState();
	},

	isChanged: function() {
		return this.changed;
	},

	// The file was written: what is on screen is what is on the disk.
	markSaved: function() {
		this.changed = false;
		this.showState();
	},

	clear: function() {
		this.changed = false;
		this.$.text.setText("", true);
	},

	showState: function() {
		this.$.state.setContent(this.canSave ? (this.changed ? "Changed" : "") : "Read-only");
		this.$.save.setDisabled(!this.changed);
	},

	textEdited: function() {
		if (!this.changed) {
			this.changed = true;
			this.showState();
		}
	},

	saveClick: function() {
		if (this.changed) {
			this.doSave(this.$.text.getText());
		}
	},

	backClick: function() {
		this.doClose(this.changed);
	}
});
