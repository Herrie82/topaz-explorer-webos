# Run by build-7z.sh from the top of the p7zip source.
#
# Adds to the single program (7za) the parts p7zip keeps in its format library
# (7z.so) and its RAR plug-in, by copying their build rules into 7za's list.
import re

base = "CPP/7zip/Bundles/Alone/makefile.list"
extra = ["CPP/7zip/Bundles/Format7zFree/makefile.list", "CPP/7zip/Compress/Rar/makefile.list"]
# The parts that only make sense in a library.
skip = set(["ArchiveExports.o", "CodecExports.o", "DllExports2.o", "DllExportsCompress.o", "NewHandler.o"])

text = open(base).read()
have = set(re.findall(r"^(\S+\.o) :", text, re.M))
rules = []
names = []
for path in extra:
    lines = open(path).read().split("\n")
    for i, line in enumerate(lines):
        m = re.match(r"^(\S+\.o) :", line)
        if m and m.group(1) not in have and m.group(1) not in skip:
            have.add(m.group(1))
            names.append(m.group(1))
            rules.append(line + "\n" + lines[i + 1] + "\n")

at = text.index("\nOBJS=")
text = text[:at] + "\n" + "".join(rules) + text[at:]
mark = " $(OBJ_AES) \\\n"
at = text.rindex(mark)
text = text[:at] + "".join(" %s \\\n" % n for n in names) + text[at:]
open(base, "w").write(text)
print("added %d parts to 7za" % len(names))
