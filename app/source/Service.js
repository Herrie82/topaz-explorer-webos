/* Calls to the file service and to the system, each with a plain callback.

	this.$.svc.ask("list", {path: p}, function(r) { if (r.ok) ... else show(r.error) });

	The callback always runs, with ok: false and an error sentence on failure. */
enyo.kind({
	name: "FM.Service",
	kind: enyo.Component,
	components: [
		{name: "files", kind: "PalmService", service: "palm://com.palm.stark.files.service/",
			onSuccess: "answered", onFailure: "failed"},
		{name: "apps", kind: "PalmService", service: "palm://com.palm.applicationManager/",
			onSuccess: "answered", onFailure: "failed"}
	],

	ask: function(method, params, callback) {
		this.send(this.$.files, method, params, callback);
	},

	// Open a file in whichever app handles its kind.
	// The path goes as it is, spaces and all: apps such as Adobe Reader use
	// what follows "file://" as the file's name without decoding %20 and the like.
	openFile: function(path, callback) {
		this.send(this.$.apps, "open", {target: "file://" + path}, callback);
	},

	send: function(service, method, params, callback) {
		if (!window.PalmSystem) {
			callback({ok: false, error: "This only works on a webOS device."});
			return;
		}
		// Extra properties given here end up on the request the handlers receive.
		service.call(params || {}, {method: method, fmCallback: callback, fmMethod: method});
	},

	answered: function(inSender, inResponse, inRequest) {
		var r = inResponse || {};
		if (r.ok === undefined) {
			// The system's own services only say returnValue.
			r.ok = r.returnValue !== false;
		}
		if (!r.ok && !r.error) {
			r.error = r.errorText || "That did not work.";
		}
		if (inRequest.fmCallback) {
			inRequest.fmCallback(r);
		}
	},

	failed: function(inSender, inResponse, inRequest) {
		FM.log(inRequest.fmMethod + " failed: " + enyo.json.stringify(inResponse));
		if (inRequest.fmCallback) {
			inRequest.fmCallback({ok: false, error: (inResponse && inResponse.errorText) || "That did not work.",
				raw: inResponse});
		}
	}
});
