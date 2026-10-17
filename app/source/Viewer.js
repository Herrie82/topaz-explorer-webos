/* The picture viewer: one picture filling the screen, with the others from the
	same folder a swipe or a tap of the arrows away. webOS has no app that takes
	a picture file to show, so Topaz Explorer shows them itself. */
enyo.kind({
	name: "FM.Viewer",
	kind: enyo.VFlexBox,
	className: "fm-viewer",
	events: {
		onClose: ""
	},
	components: [
		{kind: "HFlexBox", align: "center", className: "fm-top", components: [
			{kind: "Button", caption: "Back", className: "enyo-button-dark", onclick: "doClose"},
			{name: "title", flex: 1, className: "fm-viewer-title"},
			{name: "count", className: "fm-viewer-count"},
			{name: "prev", kind: "IconButton", icon: "images/back.png", className: "enyo-button-dark fm-nav", onclick: "prevClick"},
			{name: "next", kind: "IconButton", icon: "images/forward.png", className: "enyo-button-dark fm-nav", onclick: "nextClick"}
		]},
		{name: "stage", flex: 1, className: "fm-viewer-stage"}
	],

	create: function() {
		this.inherited(arguments);
		this.pictures = [];
		this.index = 0;
	},

	// Show one of a folder's pictures: (entries, which one)
	showPictures: function(pictures, index) {
		this.pictures = pictures;
		this.showAt(index);
	},

	// The path of the picture on show, so the list can be left at it.
	getCurrent: function() {
		return this.pictures[this.index];
	},

	// Let go of the picture when the viewer is left.
	clear: function() {
		this.pictures = [];
		this.$.stage.applyStyle("background-image", null);
	},

	showAt: function(index) {
		var e = this.pictures[index];
		if (!e) {
			return;
		}
		this.index = index;
		this.$.title.setContent(e.n);
		this.$.count.setContent((index + 1) + " of " + this.pictures.length);
		this.$.prev.setDisabled(index === 0);
		this.$.next.setDisabled(index === this.pictures.length - 1);
		if (FM.isNet(e.path) && !e.local) {
			// On a site: brought down first (fetcher, set by the app).
			var self = this;
			this.$.stage.applyStyle("background-image", null);
			this.$.title.setContent(e.n + " (loading…)");
			this.fetcher(e, function() {
				if (self.pictures[self.index] === e) {
					self.showAt(self.index);
				}
			});
			return;
		}
		var path = e.local || e.path;
		// The system scales a picture down to fit the screen, which keeps a
		// large photo from being loaded whole. It does not keep a GIF moving,
		// so those are shown as they are.
		this.$.stage.applyStyle("background-image",
			e.ext === "gif" ? "url('" + FM.fileUrl(path).replace(/'/g, "%27") + "')" : FM.thumbUrl(path, 1024));
	},

	prevClick: function() {
		this.showAt(this.index - 1);
	},

	nextClick: function() {
		this.showAt(this.index + 1);
	},

	// A sideways swipe goes to the picture on that side.
	dragfinishHandler: function(inSender, inEvent) {
		var dx = inEvent.dx || 0;
		var dy = inEvent.dy || 0;
		if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
			this.showAt(this.index + (dx < 0 ? 1 : -1));
		}
	}
});
