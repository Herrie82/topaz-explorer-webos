/* topaz-net: the SFTP and SMB side of Topaz Explorer's file service.
 *
 * The service starts one of these per connection and talks to it a line at a
 * time on its input and output, so one sign-in serves many requests. Fields
 * are separated by tabs; in each, '%', tab, CR and LF are written %XX.
 *
 *   open  sftp|smb  host  port  user  password  domain  hostkey  keyfiles
 *         hostkey: the SHA256 fingerprint the server must show (SFTP), or
 *         empty to learn it; keyfiles: private keys to try first, '|'-separated.
 *   home                         -> "path\t<the folder a session starts in>"
 *   ls    path                   -> "e\t<1 folder, 0 not>\t<size>\t<mtime>\t<name>" lines
 *   stat  path                   -> one "e" line
 *   get   remote  local          -> "p\t<bytes so far>" lines
 *   put   local   remote         -> "p\t<bytes so far>" lines
 *   mkdir path | rmdir path | rm path | mv from to
 *   quit
 *
 * Each request ends with "ok" or "err\t<kind>\t<message>", kind being one of
 * auth, connect, hostkey, notfound, exists, denied, notempty, local, io, usage.
 * "open" prints "hostkey\t<SHA256:...>" first for SFTP.
 *
 * On SMB the path's first part is the share; "/" lists the server's shares.
 *
 * Built by native/build-net.sh. GPL-3.0, like the rest of Topaz Explorer.
 */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <libssh2.h>
#include <libssh2_sftp.h>

#include <smb2/smb2.h>
#include <smb2/libsmb2.h>
#include <smb2/libsmb2-raw.h>
#include <smb2/libsmb2-dcerpc-srvsvc.h>
#include <smb2/smb2-errors.h>

#define MAXF 12
#define BUF (256 * 1024)
#define PROGRESS_STEP (256 * 1024)
#define PATIENCE 60   /* seconds a request may wait on the server; see too_long */

static char *buf;

/* ---- the line protocol ---------------------------------------------------- */

static void put_field(const char *s)
{
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == '%' || c == '\t' || c == '\r' || c == '\n') {
			printf("%%%02X", c);
		} else {
			putchar(c);
		}
	}
}

static void reply_ok(void)
{
	fputs("ok\n", stdout);
	fflush(stdout);
}

static void reply_err(const char *kind, const char *msg)
{
	printf("err\t%s\t", kind);
	put_field(msg ? msg : "");
	putchar('\n');
	fflush(stdout);
}

static void reply_entry(int dir, uint64_t size, uint64_t mtime, const char *name)
{
	printf("e\t%d\t%llu\t%llu\t", dir, (unsigned long long)size, (unsigned long long)mtime);
	put_field(name);
	putchar('\n');
}

static void reply_progress(uint64_t n)
{
	printf("p\t%llu\n", (unsigned long long)n);
	fflush(stdout);
}

static int hexval(int c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

/* Split a line into fields in place, decoding %XX. Returns how many. */
static int split(char *line, char **f)
{
	int n = 0;
	char *r = line;
	char *w = line;
	f[n++] = w;
	for (; *r; r++) {
		if (*r == '\t') {
			*w++ = 0;
			if (n < MAXF) {
				f[n++] = w;
			}
		} else if (*r == '%' && hexval(r[1]) >= 0 && hexval(r[2]) >= 0) {
			*w++ = (char)(hexval(r[1]) * 16 + hexval(r[2]));
			r += 2;
		} else {
			*w++ = *r;
		}
	}
	*w = 0;
	return n;
}

/* ---- a TCP connection with a time limit ------------------------------------ */

static int dial(const char *host, int port, char *why, size_t whylen)
{
	struct addrinfo hints, *res = NULL, *ai;
	char ps[16];
	int fd = -1;
	int rc;
	memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;
	snprintf(ps, sizeof(ps), "%d", port);
	rc = getaddrinfo(host, ps, &hints, &res);
	if (rc != 0) {
		snprintf(why, whylen, "unknown server");
		return -1;
	}
	for (ai = res; ai; ai = ai->ai_next) {
		struct pollfd p;
		int fl, err = 0;
		socklen_t el = sizeof(err);
		fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
		if (fd < 0) {
			continue;
		}
		fl = fcntl(fd, F_GETFL, 0);
		fcntl(fd, F_SETFL, fl | O_NONBLOCK);
		rc = connect(fd, ai->ai_addr, ai->ai_addrlen);
		if (rc < 0 && errno == EINPROGRESS) {
			p.fd = fd;
			p.events = POLLOUT;
			p.revents = 0;
			if (poll(&p, 1, 10000) == 1 &&
					getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &el) == 0 && err == 0) {
				rc = 0;
			} else {
				rc = -1;
			}
		}
		if (rc == 0) {
			fcntl(fd, F_SETFL, fl);
			break;
		}
		close(fd);
		fd = -1;
	}
	freeaddrinfo(res);
	if (fd < 0) {
		snprintf(why, whylen, "could not reach the server");
	}
	return fd;
}

static const char *b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* "SHA256:..." the way OpenSSH writes it: base64 without the padding. */
static void fingerprint(const unsigned char *h, int n, char *out)
{
	int i, o = 0;
	strcpy(out, "SHA256:");
	o = 7;
	for (i = 0; i < n; i += 3) {
		unsigned v = h[i] << 16 | (i + 1 < n ? h[i + 1] << 8 : 0) | (i + 2 < n ? h[i + 2] : 0);
		out[o++] = b64[(v >> 18) & 63];
		out[o++] = b64[(v >> 12) & 63];
		if (i + 1 < n) out[o++] = b64[(v >> 6) & 63];
		if (i + 2 < n) out[o++] = b64[v & 63];
	}
	out[o] = 0;
}

/* ---- SFTP ------------------------------------------------------------------- */

static int sock = -1;
static LIBSSH2_SESSION *ssh;
static LIBSSH2_SFTP *sftp;
static char kbd_pass[512];

static void kbd_answer(const char *name, int name_len, const char *instruction, int instruction_len,
		int num_prompts, const LIBSSH2_USERAUTH_KBDINT_PROMPT *prompts,
		LIBSSH2_USERAUTH_KBDINT_RESPONSE *responses, void **abstract)
{
	int i;
	(void)name; (void)name_len; (void)instruction; (void)instruction_len; (void)prompts; (void)abstract;
	for (i = 0; i < num_prompts; i++) {
		responses[i].text = strdup(kbd_pass);
		responses[i].length = (unsigned int)strlen(kbd_pass);
	}
}

static void sftp_err(const char *what)
{
	unsigned long fx;
	char msg[300];
	if (libssh2_session_last_errno(ssh) != LIBSSH2_ERROR_SFTP_PROTOCOL) {
		char *e = NULL;
		libssh2_session_last_error(ssh, &e, NULL, 0);
		snprintf(msg, sizeof(msg), "%s: %s", what, e ? e : "the connection failed");
		reply_err("io", msg);
		return;
	}
	fx = libssh2_sftp_last_error(sftp);
	switch (fx) {
	case LIBSSH2_FX_NO_SUCH_FILE:
	case LIBSSH2_FX_NO_SUCH_PATH:
		reply_err("notfound", what);
		break;
	case LIBSSH2_FX_PERMISSION_DENIED:
	case LIBSSH2_FX_WRITE_PROTECT:
		reply_err("denied", what);
		break;
	case LIBSSH2_FX_FILE_ALREADY_EXISTS:
		reply_err("exists", what);
		break;
	case LIBSSH2_FX_DIR_NOT_EMPTY:
		reply_err("notempty", what);
		break;
	case LIBSSH2_FX_NO_SPACE_ON_FILESYSTEM:
	case LIBSSH2_FX_QUOTA_EXCEEDED:
		reply_err("io", "the server is out of space");
		break;
	default:
		snprintf(msg, sizeof(msg), "%s (SFTP error %lu)", what, fx);
		reply_err("io", msg);
	}
}

static int sftp_open_session(char **f)
{
	const char *host = f[2];
	int port = atoi(f[3]) > 0 ? atoi(f[3]) : 22;
	const char *user = f[4];
	const char *pass = f[5];
	const char *want = f[7];
	char *keys = f[8];
	char why[200];
	char fp[64];
	const char *hash;
	char *methods;
	int authed = 0;

	sock = dial(host, port, why, sizeof(why));
	if (sock < 0) {
		reply_err("connect", why);
		return -1;
	}
	ssh = libssh2_session_init();
	if (!ssh) {
		reply_err("io", "out of memory");
		return -1;
	}
	libssh2_session_set_blocking(ssh, 1);
	libssh2_session_set_timeout(ssh, 30000);
	/* Ask for the key types OpenSSH prefers, so the fingerprint shown is the
	 * one "ssh" itself would show for the server. */
	libssh2_session_method_pref(ssh, LIBSSH2_METHOD_HOSTKEY,
		"ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,"
		"rsa-sha2-512,rsa-sha2-256,ssh-rsa");
	if (libssh2_session_handshake(ssh, sock) != 0) {
		char *e = NULL;
		libssh2_session_last_error(ssh, &e, NULL, 0);
		snprintf(why, sizeof(why), "the server did not speak SSH (%s)", e ? e : "");
		reply_err("connect", why);
		return -1;
	}
	hash = libssh2_hostkey_hash(ssh, LIBSSH2_HOSTKEY_HASH_SHA256);
	if (!hash) {
		reply_err("hostkey", "the server's key could not be read");
		return -1;
	}
	fingerprint((const unsigned char *)hash, 32, fp);
	printf("hostkey\t%s\n", fp);
	if (!want[0] || strcmp(want, fp) != 0) {
		reply_err("hostkey", want[0] ? "changed" : "new");
		return -1;
	}

	methods = libssh2_userauth_list(ssh, user, (unsigned int)strlen(user));
	if (!methods) {
		authed = libssh2_userauth_authenticated(ssh);
	}
	if (!authed && methods && strstr(methods, "publickey") && keys[0]) {
		char *k = keys;
		while (k && *k && !authed) {
			char *bar = strchr(k, '|');
			if (bar) {
				*bar = 0;
			}
			if (libssh2_userauth_publickey_fromfile(ssh, user, NULL, k, pass[0] ? pass : NULL) == 0) {
				authed = 1;
			}
			k = bar ? bar + 1 : NULL;
		}
	}
	if (!authed && methods && strstr(methods, "password") && pass[0]) {
		if (libssh2_userauth_password(ssh, user, pass) == 0) {
			authed = 1;
		}
	}
	if (!authed && methods && strstr(methods, "keyboard-interactive") && pass[0]) {
		snprintf(kbd_pass, sizeof(kbd_pass), "%s", pass);
		if (libssh2_userauth_keyboard_interactive(ssh, user, kbd_answer) == 0) {
			authed = 1;
		}
	}
	if (!authed) {
		reply_err("auth", "the server refused the name or password");
		return -1;
	}
	sftp = libssh2_sftp_init(ssh);
	if (!sftp) {
		reply_err("connect", "the server does not offer SFTP");
		return -1;
	}
	reply_ok();
	return 0;
}

static int sftp_is_dir(const char *path, LIBSSH2_SFTP_ATTRIBUTES *a)
{
	if ((a->flags & LIBSSH2_SFTP_ATTR_PERMISSIONS) && LIBSSH2_SFTP_S_ISLNK(a->permissions)) {
		/* A link: what it points at decides. */
		LIBSSH2_SFTP_ATTRIBUTES t;
		if (libssh2_sftp_stat(sftp, path, &t) == 0) {
			*a = t;
		}
	}
	return (a->flags & LIBSSH2_SFTP_ATTR_PERMISSIONS) && LIBSSH2_SFTP_S_ISDIR(a->permissions);
}

static void sftp_ls(const char *path)
{
	LIBSSH2_SFTP_HANDLE *h = libssh2_sftp_opendir(sftp, path);
	char name[1024];
	char full[4096];
	LIBSSH2_SFTP_ATTRIBUTES a;
	int n;
	if (!h) {
		sftp_err("the folder could not be opened");
		return;
	}
	while ((n = libssh2_sftp_readdir(h, name, sizeof(name), &a)) > 0) {
		int dir;
		if (!strcmp(name, ".") || !strcmp(name, "..")) {
			continue;
		}
		snprintf(full, sizeof(full), "%s%s%s", path, path[strlen(path) - 1] == '/' ? "" : "/", name);
		dir = sftp_is_dir(full, &a);
		reply_entry(dir, dir ? 0 : a.filesize, (a.flags & LIBSSH2_SFTP_ATTR_ACMODTIME) ? a.mtime : 0, name);
	}
	libssh2_sftp_closedir(h);
	if (n < 0) {
		sftp_err("the folder could not be read");
		return;
	}
	reply_ok();
}

static void sftp_stat_cmd(const char *path)
{
	LIBSSH2_SFTP_ATTRIBUTES a;
	const char *slash = strrchr(path, '/');
	int dir;
	if (libssh2_sftp_lstat(sftp, path, &a) != 0) {
		sftp_err("not found");
		return;
	}
	dir = sftp_is_dir(path, &a);
	reply_entry(dir, dir ? 0 : a.filesize, a.mtime, slash ? slash + 1 : path);
	reply_ok();
}

static void sftp_get(const char *remote, const char *local)
{
	LIBSSH2_SFTP_HANDLE *h = libssh2_sftp_open(sftp, remote, LIBSSH2_FXF_READ, 0);
	int fd;
	ssize_t n;
	uint64_t total = 0, next = PROGRESS_STEP;
	if (!h) {
		sftp_err("the file could not be opened");
		return;
	}
	fd = open(local, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd < 0) {
		libssh2_sftp_close(h);
		reply_err("local", strerror(errno));
		return;
	}
	while ((n = libssh2_sftp_read(h, buf, BUF)) > 0) {
		ssize_t o = 0;
		while (o < n) {
			ssize_t w = write(fd, buf + o, n - o);
			if (w < 0) {
				int e = errno;
				close(fd);
				libssh2_sftp_close(h);
				reply_err("local", strerror(e));
				return;
			}
			o += w;
		}
		total += n;
		alarm(PATIENCE);
		if (total >= next) {
			reply_progress(total);
			next = total + PROGRESS_STEP;
		}
	}
	libssh2_sftp_close(h);
	if (close(fd) != 0 || n < 0) {
		if (n < 0) {
			sftp_err("the transfer was cut short");
		} else {
			reply_err("local", strerror(errno));
		}
		return;
	}
	reply_progress(total);
	reply_ok();
}

static void sftp_put(const char *local, const char *remote)
{
	int fd = open(local, O_RDONLY);
	LIBSSH2_SFTP_HANDLE *h;
	ssize_t n;
	uint64_t total = 0, next = PROGRESS_STEP;
	if (fd < 0) {
		reply_err("local", strerror(errno));
		return;
	}
	h = libssh2_sftp_open(sftp, remote, LIBSSH2_FXF_WRITE | LIBSSH2_FXF_CREAT | LIBSSH2_FXF_TRUNC, 0644);
	if (!h) {
		close(fd);
		sftp_err("the file could not be made on the server");
		return;
	}
	while ((n = read(fd, buf, BUF)) > 0) {
		char *p = buf;
		while (n > 0) {
			ssize_t w = libssh2_sftp_write(h, p, n);
			if (w < 0) {
				close(fd);
				libssh2_sftp_close(h);
				sftp_err("the transfer was cut short");
				return;
			}
			p += w;
			n -= w;
			total += w;
			alarm(PATIENCE);
		}
		if (total >= next) {
			reply_progress(total);
			next = total + PROGRESS_STEP;
		}
	}
	close(fd);
	if (libssh2_sftp_close(h) != 0 || n < 0) {
		if (n < 0) {
			reply_err("local", strerror(errno));
		} else {
			sftp_err("the file could not be finished");
		}
		return;
	}
	reply_progress(total);
	reply_ok();
}

static void sftp_simple(const char *cmd, char **f, int nf)
{
	int rc;
	if (!strcmp(cmd, "mkdir")) {
		rc = libssh2_sftp_mkdir(sftp, f[1], 0755);
		if (rc != 0) {
			/* Many servers say only "failure" when it is already there. */
			LIBSSH2_SFTP_ATTRIBUTES a;
			unsigned long fx = libssh2_sftp_last_error(sftp);
			if (fx != LIBSSH2_FX_PERMISSION_DENIED && libssh2_sftp_stat(sftp, f[1], &a) == 0) {
				reply_err("exists", "already there");
				return;
			}
		}
	} else if (!strcmp(cmd, "rmdir")) {
		rc = libssh2_sftp_rmdir(sftp, f[1]);
	} else if (!strcmp(cmd, "rm")) {
		rc = libssh2_sftp_unlink(sftp, f[1]);
	} else if (!strcmp(cmd, "mv") && nf >= 3) {
		rc = libssh2_sftp_rename_ex(sftp, f[1], (unsigned int)strlen(f[1]), f[2], (unsigned int)strlen(f[2]),
			LIBSSH2_SFTP_RENAME_ATOMIC | LIBSSH2_SFTP_RENAME_NATIVE);
	} else {
		reply_err("usage", cmd);
		return;
	}
	if (rc != 0) {
		sftp_err("the server refused");
		return;
	}
	reply_ok();
}

static void sftp_home(void)
{
	char path[4096];
	int n = libssh2_sftp_realpath(sftp, ".", path, sizeof(path) - 1);
	if (n <= 0) {
		strcpy(path, "/");
	} else {
		path[n] = 0;
	}
	fputs("path\t", stdout);
	put_field(path);
	putchar('\n');
	reply_ok();
}

/* ---- SMB -------------------------------------------------------------------- */

static struct smb2_context *smb;
static char smb_host[300];
static char smb_user[256];
static char smb_pass[256];
static char smb_domain[256];
static char smb_share[256];   /* the share connected now, "" for none */

static struct smb2_context *smb_new(void)
{
	struct smb2_context *c = smb2_init_context();
	if (!c) {
		return NULL;
	}
	smb2_set_security_mode(c, SMB2_NEGOTIATE_SIGNING_ENABLED);
	smb2_set_version(c, SMB2_VERSION_ANY);
	smb2_set_timeout(c, 30);
	smb2_set_user(c, smb_user[0] ? smb_user : "guest");
	smb2_set_password(c, smb_pass);
	if (smb_domain[0]) {
		smb2_set_domain(c, smb_domain);
	}
	smb2_set_workstation(c, "TOPAZ");
	return c;
}

static void smb_drop(void)
{
	if (smb) {
		if (smb_share[0]) {
			smb2_disconnect_share(smb);
		}
		smb2_destroy_context(smb);
		smb = NULL;
	}
	smb_share[0] = 0;
}

static int smb_auth_failed(struct smb2_context *c)
{
	uint32_t s = (uint32_t)smb2_get_nterror(c);
	return s == SMB2_STATUS_LOGON_FAILURE || s == SMB2_STATUS_WRONG_PASSWORD ||
		s == SMB2_STATUS_ACCOUNT_RESTRICTION || s == SMB2_STATUS_WRONG_PASSWORD_CORE;
}

/* Connect to a share, reusing the connection when it is the one in use. */
static int smb_use(const char *share)
{
	if (smb && !strcasecmp(share, smb_share)) {
		return 0;
	}
	smb_drop();
	smb = smb_new();
	if (!smb) {
		reply_err("io", "out of memory");
		return -1;
	}
	if (smb2_connect_share(smb, smb_host, share, NULL) < 0) {
		char msg[300];
		if (smb_auth_failed(smb) || (!strcmp(share, "IPC$") &&
				(uint32_t)smb2_get_nterror(smb) == SMB2_STATUS_ACCESS_DENIED)) {
			/* A server that turns a guest away from IPC$ wants a name. */
			reply_err("auth", "the server refused the name or password");
		} else if ((uint32_t)smb2_get_nterror(smb) == SMB2_STATUS_BAD_NETWORK_NAME) {
			reply_err("notfound", "there is no shared folder by that name");
		} else if ((uint32_t)smb2_get_nterror(smb) == SMB2_STATUS_ACCESS_DENIED) {
			reply_err("denied", "the server would not open that shared folder");
		} else {
			snprintf(msg, sizeof(msg), "%s", smb2_get_error(smb));
			reply_err("connect", msg);
		}
		smb2_destroy_context(smb);
		smb = NULL;
		return -1;
	}
	snprintf(smb_share, sizeof(smb_share), "%s", share);
	return 0;
}

/* "/share/dir/file" -> share and "dir/file". */
static int smb_split(const char *path, char *share, size_t sl, const char **rest)
{
	const char *p = path;
	const char *slash;
	while (*p == '/') {
		p++;
	}
	slash = strchr(p, '/');
	if (!slash) {
		snprintf(share, sl, "%s", p);
		*rest = "";
	} else {
		size_t n = (size_t)(slash - p);
		if (n >= sl) {
			n = sl - 1;
		}
		memcpy(share, p, n);
		share[n] = 0;
		*rest = slash + 1;
	}
	return share[0] ? 0 : -1;
}

static void smb_errno(int rc, const char *what)
{
	char msg[300];
	rc = rc < 0 ? -rc : rc;
	/* For the service's log. */
	fprintf(stderr, "smb: %s: %s (status %08x, errno %d)\n", what, smb ? smb2_get_error(smb) : "",
		smb ? (unsigned)smb2_get_nterror(smb) : 0u, rc);
	if (smb && smb_auth_failed(smb)) {
		reply_err("auth", "the server refused the name or password");
	} else if (rc == ENOENT || rc == ENOTDIR) {
		reply_err("notfound", what);
	} else if (rc == EEXIST) {
		reply_err("exists", what);
	} else if (rc == EACCES || rc == EPERM || rc == EROFS) {
		reply_err("denied", what);
	} else if (rc == ENOTEMPTY) {
		reply_err("notempty", what);
	} else if (rc == ENOSPC) {
		reply_err("io", "the server is out of space");
	} else {
		snprintf(msg, sizeof(msg), "%s: %s", what, smb && smb2_get_error(smb)[0] ? smb2_get_error(smb) : strerror(rc));
		reply_err("io", msg);
		/* The connection may be broken: start afresh next time. */
		smb_drop();
	}
}

struct share_wait {
	int done;
	int status;
	struct srvsvc_NetrShareEnum_rep *rep;
};

static void share_cb(struct smb2_context *c, int status, void *data, void *priv)
{
	struct share_wait *w = priv;
	(void)c;
	w->done = 1;
	w->status = status;
	w->rep = data;
}

static void smb_shares(void)
{
	struct share_wait w;
	uint32_t i;
	memset(&w, 0, sizeof(w));
	if (smb_use("IPC$") != 0) {
		return;
	}
	if (smb2_share_enum_async(smb, SHARE_INFO_1, share_cb, &w) != 0) {
		smb_errno(EIO, "the shared folders could not be listed");
		return;
	}
	while (!w.done) {
		struct pollfd p;
		p.fd = smb2_get_fd(smb);
		p.events = smb2_which_events(smb);
		p.revents = 0;
		if (poll(&p, 1, 1000) < 0) {
			break;
		}
		if (smb2_service(smb, p.revents) < 0) {
			break;
		}
	}
	if (!w.done || w.status != 0 || !w.rep) {
		smb_errno(w.status ? w.status : EIO, "the shared folders could not be listed");
		return;
	}
	for (i = 0; i < w.rep->ses.ShareInfo.Level1.EntriesRead; i++) {
		struct srvsvc_SHARE_INFO_1 *s = &w.rep->ses.ShareInfo.Level1.Buffer->share_info_1[i];
		const char *name = s->netname.utf8;
		size_t len = name ? strlen(name) : 0;
		if ((s->type & 3) != SHARE_TYPE_DISKTREE || !len || name[len - 1] == '$') {
			continue;
		}
		reply_entry(1, 0, 0, name);
	}
	smb2_free_data(smb, w.rep);
	/* IPC$ is no use for files. */
	smb_drop();
	reply_ok();
}

static void smb_ls(const char *path)
{
	char share[256];
	const char *rest;
	struct smb2dir *d;
	struct smb2dirent *e;
	if (smb_split(path, share, sizeof(share), &rest) != 0) {
		smb_shares();
		return;
	}
	if (smb_use(share) != 0) {
		return;
	}
	if (rest[0]) {
		/* libsmb2 6.0 never returns from opendir on a folder that is not
		 * there; stat answers. */
		struct smb2_stat_64 st;
		int rc = smb2_stat(smb, rest, &st);
		if (rc < 0) {
			smb_errno(rc, "the folder could not be opened");
			return;
		}
		if (st.smb2_type != SMB2_TYPE_DIRECTORY) {
			reply_err("notfound", "not a folder");
			return;
		}
	}
	d = smb2_opendir(smb, rest);
	if (!d) {
		smb_errno(smb2_get_nterror(smb) ? nterror_to_errno(smb2_get_nterror(smb)) : ENOENT,
			"the folder could not be opened");
		return;
	}
	while ((e = smb2_readdir(smb, d)) != NULL) {
		int dir = e->st.smb2_type == SMB2_TYPE_DIRECTORY;
		if (!strcmp(e->name, ".") || !strcmp(e->name, "..")) {
			continue;
		}
		reply_entry(dir, dir ? 0 : e->st.smb2_size, e->st.smb2_mtime, e->name);
	}
	smb2_closedir(smb, d);
	reply_ok();
}

static void smb_stat_cmd(const char *path)
{
	char share[256];
	const char *rest;
	struct smb2_stat_64 st;
	const char *slash = strrchr(path, '/');
	int rc;
	if (smb_split(path, share, sizeof(share), &rest) != 0) {
		reply_entry(1, 0, 0, "/");
		reply_ok();
		return;
	}
	if (smb_use(share) != 0) {
		return;
	}
	if (!rest[0]) {
		reply_entry(1, 0, 0, share);
		reply_ok();
		return;
	}
	rc = smb2_stat(smb, rest, &st);
	if (rc < 0) {
		smb_errno(rc, "not found");
		return;
	}
	reply_entry(st.smb2_type == SMB2_TYPE_DIRECTORY, st.smb2_size, st.smb2_mtime, slash ? slash + 1 : path);
	reply_ok();
}

static void smb_get(const char *remote, const char *local)
{
	char share[256];
	const char *rest;
	struct smb2fh *fh;
	int fd, n;
	uint32_t chunk;
	uint64_t total = 0, next = PROGRESS_STEP;
	if (smb_split(remote, share, sizeof(share), &rest) != 0 || !rest[0]) {
		reply_err("usage", "not a file");
		return;
	}
	if (smb_use(share) != 0) {
		return;
	}
	fh = smb2_open(smb, rest, O_RDONLY);
	if (!fh) {
		smb_errno(nterror_to_errno(smb2_get_nterror(smb)), "the file could not be opened");
		return;
	}
	fd = open(local, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd < 0) {
		smb2_close(smb, fh);
		reply_err("local", strerror(errno));
		return;
	}
	chunk = smb2_get_max_read_size(smb);
	if (chunk == 0 || chunk > BUF) {
		chunk = BUF;
	}
	while ((n = smb2_read(smb, fh, (uint8_t *)buf, chunk)) > 0) {
		int o = 0;
		while (o < n) {
			ssize_t w = write(fd, buf + o, n - o);
			if (w < 0) {
				int e = errno;
				close(fd);
				smb2_close(smb, fh);
				reply_err("local", strerror(e));
				return;
			}
			o += (int)w;
		}
		total += n;
		alarm(PATIENCE);
		if (total >= next) {
			reply_progress(total);
			next = total + PROGRESS_STEP;
		}
	}
	smb2_close(smb, fh);
	if (n < 0) {
		close(fd);
		smb_errno(n, "the transfer was cut short");
		return;
	}
	if (close(fd) != 0) {
		reply_err("local", strerror(errno));
		return;
	}
	reply_progress(total);
	reply_ok();
}

static void smb_put(const char *local, const char *remote)
{
	char share[256];
	const char *rest;
	struct smb2fh *fh;
	int fd;
	ssize_t n;
	uint32_t chunk;
	uint64_t total = 0, next = PROGRESS_STEP;
	if (smb_split(remote, share, sizeof(share), &rest) != 0 || !rest[0]) {
		reply_err("denied", "files go in a shared folder, not beside them");
		return;
	}
	fd = open(local, O_RDONLY);
	if (fd < 0) {
		reply_err("local", strerror(errno));
		return;
	}
	if (smb_use(share) != 0) {
		close(fd);
		return;
	}
	fh = smb2_open(smb, rest, O_WRONLY | O_CREAT | O_TRUNC);
	if (!fh) {
		close(fd);
		smb_errno(nterror_to_errno(smb2_get_nterror(smb)), "the file could not be made on the server");
		return;
	}
	chunk = smb2_get_max_write_size(smb);
	if (chunk == 0 || chunk > BUF) {
		chunk = BUF;
	}
	while ((n = read(fd, buf, chunk)) > 0) {
		uint8_t *p = (uint8_t *)buf;
		while (n > 0) {
			int w = smb2_write(smb, fh, p, (uint32_t)n);
			if (w <= 0) {
				close(fd);
				smb2_close(smb, fh);
				smb_errno(w ? w : EIO, "the transfer was cut short");
				return;
			}
			p += w;
			n -= w;
			total += w;
			alarm(PATIENCE);
		}
		if (total >= next) {
			reply_progress(total);
			next = total + PROGRESS_STEP;
		}
	}
	close(fd);
	if (smb2_close(smb, fh) < 0 || n < 0) {
		if (n < 0) {
			reply_err("local", strerror(errno));
		} else {
			smb_errno(EIO, "the file could not be finished");
		}
		return;
	}
	reply_progress(total);
	reply_ok();
}

static void smb_simple(const char *cmd, char **f, int nf)
{
	char share[256], share2[256];
	const char *rest, *rest2;
	int rc;
	if (smb_split(f[1], share, sizeof(share), &rest) != 0 || !rest[0]) {
		reply_err("denied", "shared folders themselves cannot be changed from here");
		return;
	}
	if (smb_use(share) != 0) {
		return;
	}
	if (!strcmp(cmd, "mkdir")) {
		rc = smb2_mkdir(smb, rest);
		if (rc == -EEXIST || (uint32_t)smb2_get_nterror(smb) == SMB2_STATUS_OBJECT_NAME_COLLISION) {
			reply_err("exists", "already there");
			return;
		}
	} else if (!strcmp(cmd, "rmdir")) {
		rc = smb2_rmdir(smb, rest);
	} else if (!strcmp(cmd, "rm")) {
		rc = smb2_unlink(smb, rest);
	} else if (!strcmp(cmd, "mv") && nf >= 3) {
		if (smb_split(f[2], share2, sizeof(share2), &rest2) != 0 || strcasecmp(share, share2) != 0 || !rest2[0]) {
			reply_err("usage", "things cannot be moved between shared folders");
			return;
		}
		rc = smb2_rename(smb, rest, rest2);
	} else {
		reply_err("usage", cmd);
		return;
	}
	if (rc < 0) {
		smb_errno(rc, "the server refused");
		return;
	}
	reply_ok();
}

static int smb_open_session(char **f)
{
	const char *host = f[2];
	int port = atoi(f[3]);
	struct share_wait w;
	char why[200];
	/* libsmb2 takes the system's full TCP time (40 seconds and more) to give
	 * up on a server that is not there; a try of our own says so in 10. */
	int probe = dial(host, port > 0 ? port : 445, why, sizeof(why));
	if (probe < 0) {
		reply_err("connect", why);
		return -1;
	}
	close(probe);
	if (port > 0 && port != 445) {
		snprintf(smb_host, sizeof(smb_host), "%s:%d", host, port);
	} else {
		snprintf(smb_host, sizeof(smb_host), "%s", host);
	}
	snprintf(smb_user, sizeof(smb_user), "%s", f[4]);
	snprintf(smb_pass, sizeof(smb_pass), "%s", f[5]);
	snprintf(smb_domain, sizeof(smb_domain), "%s", f[6]);
	(void)w;
	/* Signing in to IPC$ tells whether the name and password are good. */
	if (smb_use("IPC$") != 0) {
		return -1;
	}
	smb_drop();
	reply_ok();
	return 0;
}

/* ---- main ------------------------------------------------------------------- */

/* A server that stops answering must not hold a request up for ever: each one
 * has a minute, renewed as a transfer moves. Past that the program ends,
 * saying so, and the service starts a new one for the next request. */


static void too_long(int sig)
{
	static const char msg[] = "err\tconnect\tthe server stopped answering\n";
	(void)sig;
	if (write(1, msg, sizeof(msg) - 1) < 0) {
		_exit(3);
	}
	_exit(3);
}

int main(void)
{
	char *line = NULL;
	size_t cap = 0;
	ssize_t len;
	int kind = 0;  /* 1 sftp, 2 smb */
	char *f[MAXF];
	int i;

	/* The service's own connections to the system's message hub come along
	 * when it starts this; held here, the hub would think the service still
	 * there after it has gone, and calls to it would hang. */
	for (i = 3; i < 1024; i++) {
		close(i);
	}
	signal(SIGPIPE, SIG_IGN);
	signal(SIGALRM, too_long);
	buf = malloc(BUF);
	if (!buf || libssh2_init(0) != 0) {
		reply_err("io", "could not start");
		return 1;
	}
	while ((len = getline(&line, &cap, stdin)) > 0) {
		int nf;
		while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
			line[--len] = 0;
		}
		nf = split(line, f);
		for (i = nf; i < MAXF; i++) {
			f[i] = "";
		}
		if (!strcmp(f[0], "quit")) {
			break;
		}
		alarm(PATIENCE);
		if (!strcmp(f[0], "open")) {
			if (kind) {
				reply_err("usage", "already open");
			} else if (!strcmp(f[1], "sftp")) {
				if (sftp_open_session(f) != 0) {
					return 2;
				}
				kind = 1;
			} else if (!strcmp(f[1], "smb")) {
				if (smb_open_session(f) != 0) {
					return 2;
				}
				kind = 2;
			} else {
				reply_err("usage", "sftp or smb");
			}
			continue;
		}
		if (!kind) {
			reply_err("usage", "not open");
			continue;
		}
		if (!f[1][0] && strcmp(f[0], "home") != 0) {
			reply_err("usage", "no path");
			continue;
		}
		if (kind == 1) {
			if (!strcmp(f[0], "ls")) sftp_ls(f[1]);
			else if (!strcmp(f[0], "stat")) sftp_stat_cmd(f[1]);
			else if (!strcmp(f[0], "get")) sftp_get(f[1], f[2]);
			else if (!strcmp(f[0], "put")) sftp_put(f[1], f[2]);
			else if (!strcmp(f[0], "home")) sftp_home();
			else sftp_simple(f[0], f, nf);
		} else {
			if (!strcmp(f[0], "ls")) smb_ls(f[1]);
			else if (!strcmp(f[0], "stat")) smb_stat_cmd(f[1]);
			else if (!strcmp(f[0], "get")) smb_get(f[1], f[2]);
			else if (!strcmp(f[0], "put")) smb_put(f[1], f[2]);
			else if (!strcmp(f[0], "home")) {
				fputs("path\t/\n", stdout);
				reply_ok();
			} else smb_simple(f[0], f, nf);
		}
		alarm(0);
	}
	if (sftp) {
		libssh2_sftp_shutdown(sftp);
	}
	if (ssh) {
		libssh2_session_disconnect(ssh, "bye");
		libssh2_session_free(ssh);
	}
	smb_drop();
	return 0;
}
