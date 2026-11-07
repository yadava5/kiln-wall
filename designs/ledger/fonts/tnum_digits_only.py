# Schibsted Grotesk's tnum also swaps . , : ; # % for figure-width forms, which print
# "62 ,502". Keep tnum for the ten digits only, so tabular-nums can be on everywhere.
import sys
from fontTools.ttLib import TTFont

src, dst = sys.argv[1], sys.argv[2]
t = TTFont(src)
g = t["GSUB"].table
digits = {"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"}
for fr in g.FeatureList.FeatureRecord:
    if fr.FeatureTag != "tnum":
        continue
    for li in fr.Feature.LookupListIndex:
        for st in g.LookupList.Lookup[li].SubTable:
            st = getattr(st, "ExtSubTable", st)
            st.mapping = {k: v for k, v in st.mapping.items() if k in digits}
            print(dst, sorted(st.mapping))
# a Modified Version (OFL 1.1): say so in the names
for n in t["name"].names:
    if n.nameID in (3, 5):
        n.string = n.toUnicode() + "; tnum limited to digits for The Ledger"
t.flavor = "woff2"
t.save(dst)
