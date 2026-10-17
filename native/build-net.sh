#!/bin/bash
# Builds topaz-net, the program the Topaz Explorer service runs for SFTP and
# SMB folders, for the TouchPad.
#
#     wsl -u <user> -- bash /mnt/h/topaz-explorer-webos/native/build-net.sh
#
# topaz-net.c is Topaz Explorer's own. It is linked with:
#   - libssh2 1.11.1 (BSD-3-Clause), for SFTP,
#   - OpenSSL 1.1.1w (OpenSSL/SSLeay license), libssh2's cryptography,
#   - libsmb2 6.0.0 (LGPL-2.1 or later), for SMB 2 and 3.
# Their licenses are copied next to this script. The sources are downloaded,
# not kept in this repository.
#
# As with 7za (build-7z.sh), everything goes into one program: the TouchPad's
# loader cannot load libraries made by the PDK's 2011 compiler. The C library
# is the TouchPad's, taken from the PDK. Build on a native Linux filesystem.
set -e

PDK=${PDK:-/opt/PalmPDK}
WORK=${WORK:-/mnt/luneos/webos-pdk/build/topaz-net}
HERE=$(cd "$(dirname "$0")" && pwd)
HOST=arm-none-linux-gnueabi
BIN=$PDK/arm-toolchain/bin/$HOST
ARCH="-march=armv7-a -mfpu=neon -mfloat-abi=softfp"
J=${J:-8}

OSSL=openssl-1.1.1w
OSSL_URL=https://www.openssl.org/source/$OSSL.tar.gz
OSSL_SHA=cf3098950cb4d853ad95c0841f1f9c6d3dc102dccfcacd521d93925208b76ac8
SSH2=libssh2-1.11.1
SSH2_URL=https://libssh2.org/download/$SSH2.tar.gz
SSH2_SHA=d9ec76cbe34db98eec3539fe2c899d26b0c837cb3eb466a56b0f109cabf658f7
SMB2=libsmb2-6.0.0
SMB2_URL=https://github.com/sahlberg/libsmb2/archive/refs/tags/v6.0.0.tar.gz
SMB2_SHA=c65a7a2b7a6e967a4fd5b6168fca4f1f7d0362a3510767700609c770e3ead1e8

mkdir -p "$WORK"
cd "$WORK"
PREFIX=$WORK/prefix
mkdir -p "$PREFIX/lib" "$PREFIX/include"

fetch() {  # name url sha256
	if [ ! -f "$1.tar.gz" ]; then
		curl -L --fail -o "$1.tar.gz" "$2"
	fi
	echo "$3  $1.tar.gz" | sha256sum -c -
}

# ---- OpenSSL: libcrypto only ----
if [ ! -f "$PREFIX/lib/libcrypto.a" ]; then
	fetch $OSSL $OSSL_URL $OSSL_SHA
	rm -rf $OSSL && tar xzf $OSSL.tar.gz
	(cd $OSSL &&
		./Configure linux-armv4 no-shared no-asm no-tests no-engine no-dso no-comp no-ssl3 \
			--cross-compile-prefix=$BIN- --prefix="$PREFIX" $ARCH -O2 &&
		make -j$J build_libs &&
		cp libcrypto.a libssl.a "$PREFIX/lib/" &&
		cp -r include/openssl "$PREFIX/include/")
fi

# ---- libssh2 ----
if [ ! -f "$PREFIX/lib/libssh2.a" ]; then
	fetch $SSH2 $SSH2_URL $SSH2_SHA
	rm -rf $SSH2 && tar xzf $SSH2.tar.gz
	(cd $SSH2 &&
		./configure --host=$HOST --prefix="$PREFIX" --disable-shared --enable-static \
			--with-crypto=openssl --with-libssl-prefix="$PREFIX" --without-libz \
			--disable-examples-build --disable-tests --disable-docker-tests --disable-sshd-tests \
			CC=$BIN-gcc AR=$BIN-ar RANLIB=$BIN-ranlib \
			CFLAGS="$ARCH -O2" CPPFLAGS="-I$PREFIX/include" \
			LDFLAGS="-L$PREFIX/lib -L$PDK/device/lib" LIBS="-ldl -lpthread" &&
		make -j$J -C src &&
		cp src/.libs/libssh2.a "$PREFIX/lib/" &&
		cp include/libssh2.h include/libssh2_sftp.h include/libssh2_publickey.h "$PREFIX/include/")
fi

# ---- libsmb2: no autotools here, so its library is compiled directly ----
if [ ! -f "$PREFIX/lib/libsmb2.a" ]; then
	fetch $SMB2 $SMB2_URL $SMB2_SHA
	rm -rf $SMB2 && tar xzf $SMB2.tar.gz
	(cd $SMB2 &&
		cat > config.h <<'EOF'
#define HAVE_ARPA_INET_H 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_LINGER 1
#define HAVE_NETDB_H 1
#define HAVE_NETINET_IN_H 1
#define HAVE_NETINET_TCP_H 1
#define HAVE_POLL_H 1
#define HAVE_SOCKADDR_STORAGE 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_POLL_H 1
#define HAVE_SYS_SOCKET_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_UIO_H 1
#define HAVE_TIME_H 1
#define HAVE_UNISTD_H 1
#define HAVE_ADDRINFO 1
EOF
		# C99 does not allow the same typedef twice, and compat.h repeats
		# libsmb2.h's t_socket, hmac-md5.h md5.h's UWORD32; unicode.c uses offsetof without stddef.h.
		sed -i "s/^typedef int t_socket;/#ifndef T_SOCKET_DONE\n#define T_SOCKET_DONE\ntypedef int t_socket;\n#endif/" lib/compat.h include/smb2/libsmb2.h &&
		sed -i "s/^typedef uint32_t UWORD32;/#ifndef UWORD32_DONE\n#define UWORD32_DONE\ntypedef uint32_t UWORD32;\n#endif/" lib/md5.h lib/hmac-md5.h &&
		rm -rf obj && mkdir obj &&
		for c in lib/*.c; do
			case $c in *krb5-wrapper.c) continue ;; esac
			$BIN-gcc -std=gnu99 $ARCH -O2 -DHAVE_CONFIG_H -D_GNU_SOURCE -D_FILE_OFFSET_BITS=64 \
				"-D_U_=__attribute__((unused))" -I. -Iinclude -Iinclude/smb2 \
				-include stddef.h -c "$c" -o "obj/$(basename "$c" .c).o" || exit 1
		done &&
		$BIN-ar rcs "$PREFIX/lib/libsmb2.a" obj/*.o &&
		mkdir -p "$PREFIX/include/smb2" &&
		cp include/smb2/*.h "$PREFIX/include/smb2/")
fi

# ---- topaz-net ----
# (The compiler cannot read from a Windows drive: work on a copy.)
cp "$HERE/topaz-net.c" .
$BIN-gcc -std=gnu99 $ARCH -O2 -Wall -o topaz-net topaz-net.c \
	-I"$PREFIX/include" -I"$PREFIX/include/smb2" \
	-L"$PREFIX/lib" -lssh2 -lsmb2 -lcrypto \
	-L$PDK/device/lib -Wl,--allow-shlib-undefined -static-libgcc -ldl -lpthread
$BIN-strip topaz-net

OUT="$HERE/../service/bin"
mkdir -p "$OUT"
cp topaz-net "$OUT/topaz-net"
cp $OSSL/LICENSE "$HERE/LICENSE.openssl"
cp $SSH2/COPYING "$HERE/LICENSE.libssh2"
cp $SMB2/COPYING "$HERE/LICENSE.libsmb2"
ls -la "$OUT"
file topaz-net
