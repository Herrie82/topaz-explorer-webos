#!/bin/bash
# Builds 7za, the archiver the Files service runs, for the TouchPad.
#
#     wsl -u <user> -- bash /mnt/h/files-webos/native/build-7z.sh
#
# This is p7zip 16.02 (7-Zip for POSIX) built as one program, 7za, holding every
# format the full 7-Zip has: it reads and writes 7z, zip, tar, gzip, bzip2 and
# xz, and reads rar, cab, iso and more. p7zip normally keeps most formats in a
# library (7z.so) and RAR in a plug-in; the TouchPad's program loader cannot
# load libraries made by this compiler, so their parts are linked into 7za
# here instead. p7zip is LGPL 2.1 or later with BSD-licensed LZMA code. The RAR
# reading code is under the unRAR license (LICENSE.unrar): free to use for
# reading RAR archives, not to be used to write them.
# The source is downloaded, not kept in this repository; get it from the
# address below.
#
# Built with the webOS PDK's 2011 toolchain, on a native Linux filesystem (the
# toolchain cannot read sources from a Windows drive). The C++ library is
# linked in, because the TouchPad's own is older than the compiler's; the C
# library is the TouchPad's, taken from the PDK.
set -e

PDK=${PDK:-/opt/PalmPDK}
WORK=${WORK:-/mnt/luneos/webos-pdk/build/files-7z}
URL=https://downloads.sourceforge.net/project/p7zip/p7zip/16.02/p7zip_16.02_src_all.tar.bz2
SHA256=5eb20ac0e2944f6cb9c2d51dd6c4518941c185347d4089ea89087ffdd6e2341f
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=$PDK/arm-toolchain/bin/arm-none-linux-gnueabi

mkdir -p "$WORK"
cd "$WORK"
if [ ! -f p7zip.tar.bz2 ]; then
	curl -L --fail -o p7zip.tar.bz2 "$URL"
fi
echo "$SHA256  p7zip.tar.bz2" | sha256sum -c -
rm -rf p7zip_16.02
tar xjf p7zip.tar.bz2
cd p7zip_16.02

cat > makefile.machine <<EOF
OPTFLAGS=-O2 -s
ALLFLAGS=\${OPTFLAGS} -pipe -march=armv7-a -mfpu=neon -mfloat-abi=softfp \\
	-D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE \\
	-DNDEBUG -D_REENTRANT -DENV_UNIX \\
	-D_7ZIP_LARGE_PAGES \\
	\$(LOCAL_FLAGS)
CXX=$BIN-g++
CC=$BIN-gcc
CC_SHARED=-fPIC
LINK_SHARED=-fPIC -shared
LOCAL_LIBS=-L$PDK/device/lib -Wl,--allow-shlib-undefined -static-libstdc++ -static-libgcc -lpthread
LOCAL_LIBS_DLL=\$(LOCAL_LIBS) -ldl
OBJ_CRC32=\$(OBJ_CRC32_C)
OBJ_AES=
EOF

# Add to the single program what the library and the RAR plug-in would hold.
python3 "$HERE/merge-7z-lists.py"

make -j4 7za
$BIN-strip bin/7za
OUT="$HERE/../service/bin"
rm -rf "$OUT/7z"
mkdir -p "$OUT"
cp bin/7za "$OUT/7za"
cp DOC/License.txt "$HERE/LICENSE.p7zip"
cp DOC/unRarLicense.txt "$HERE/LICENSE.unrar"
ls -la "$OUT"
file bin/7za
