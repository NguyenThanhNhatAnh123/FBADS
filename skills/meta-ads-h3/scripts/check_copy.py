#!/usr/bin/env python3
"""Soát copy quảng cáo theo quy tắc shop First Nations Legacy (cùng bộ quy tắc với src/agent/copy/rules.ts).

Dùng:
    python scripts/check_copy.py copy.json
    echo '{"variants":[...],"page_text":"..."}' | python scripts/check_copy.py

copy.json = {"variants": [{"variant": 1, "style": "...", "headline": "...", "primary_text": "...",
             "description": "...", "reason": "..."}], "page_text": "mô tả + giá + ưu đãi trên trang sản phẩm"}

In ra từng lỗi theo phương án; thoát mã 0 nếu sạch, 1 nếu còn lỗi, 2 nếu đầu vào sai.
"""
import json
import re
import sys

STYLES = ("first_person_story", "gift_giver", "product_detail")

# Cụm được phép — gỡ ra trước khi soát để không bắt nhầm.
ALLOWED_PHRASES = [
    r"native[\s-]+american[\s-]+inspired",
    r"native[\s-]+inspired",
    r"inspired\s+by\s+(the\s+)?native(\s+american)?\s+(art|artwork|designs?|patterns?|motifs?|traditions?|culture)",
    r"pacific\s+northwest[\s–—-]+inspired",
    r"indigenous[\s-]+inspired",
]

TRIBE_NAMES = [
    "navajo", "diné", "cherokee", "sioux", "lakota", "nakota", "apache", "hopi", "zuni", "pueblo",
    "cree", "ojibwe", "ojibwa", "chippewa", "anishinaabe", "iroquois", "haudenosaunee", "mohawk", "oneida", "seneca",
    "haida", "tlingit", "tsimshian", "kwakiutl", "kwakwaka'wakw", "salish", "nuu-chah-nulth",
    "choctaw", "chickasaw", "seminole", "muscogee", "comanche", "cheyenne", "arapaho", "blackfoot", "blackfeet",
    "shoshone", "ute", "paiute", "pawnee", "osage", "kiowa", "nez perce", "inuit", "yupik", "métis", "metis",
    "mi'kmaq", "mikmaq", "potawatomi", "menominee", "ho-chunk", "winnebago", "shawnee", "lenape",
    "tohono", "pima", "yaqui", "mohican", "wampanoag", "abenaki", "assiniboine", "gros ventre", "mandan", "hidatsa",
    "arikara", "yakama", "umatilla", "klamath", "modoc", "hupa", "pomo", "miwok", "chumash",
]
# Trùng từ thường (con quạ, con suối, tên bang...) — chỉ tính khi đi kèm nation / tribe / people / style...
TRIBE_NAMES_AMBIGUOUS = ["crow", "creek", "dakota", "chinook", "delaware", "huron", "cayuga", "mohave", "mojave", "dine"]
TRIBE_SUFFIX = r"(nation|nations|tribe|tribes|tribal|people|peoples|pattern|patterns|style|design|designs|art|artwork|beadwork|regalia)"

BANNED = [
    (r"\bauthentic(ally|ity)?\b", 'dùng từ "authentic"'),
    (r"\bgenuine\b", 'dùng từ "genuine" (gợi ý hàng bản địa thật)'),
    (r"\bnative[\s-]*made\b", 'dùng "Native-made"'),
    (r"\btribal[\s-]*made\b", 'dùng "tribal-made"'),
    (r"\bindian[\s-]*made\b", 'dùng "Indian-made"'),
    (r"\b(native|indigenous|tribal)[\s-]*(owned|crafted|handcrafted|produced)\b", "gợi ý sản phẩm do người bản địa làm/sở hữu"),
    (r"\b(made|crafted|handcrafted|hand[\s-]?made|created|designed|painted|drawn|carved|sewn|woven|beaded|produced|illustrated)\s+by\s+(an?\s+|our\s+|the\s+)?(native|indigenous|tribal|first\s+nations?|american\s+indian|indian|tribe)",
     'gợi ý sản phẩm do người bản địa làm ("made by Native ...")'),
    (r"\b(native|indigenous|tribal|first\s+nations?)\s+(american\s+)?(artists?|artisans?|makers?|craftsm[ae]n|craftspeople|designers?|elders?)\b",
     'nhắc "Native artist/artisan" (gợi ý người bản địa làm ra)'),
    (r"\bfrom\s+(the\s+)?(reservation|rez|tribe)\b", "gợi ý nguồn gốc bản địa"),
    (r"\b(certified|official)\s+(native|tribal|indian)\b", "gợi ý chứng nhận bản địa"),
    (r"\bsupport(s|ing)?\s+(native|indigenous|tribal)\s+(artists?|communit(y|ies)|families|tribes?)\b", "gợi ý tiền ủng hộ cộng đồng bản địa"),
    (r"\b(heals?|healing|cures?|curing|therapeutic|medicinal)\b", "hứa hẹn tác dụng sức khoẻ"),
    (r"\b(protects?|protection|shields?|guards?)\s+(you|your|against|from)\b", "hứa hẹn bảo vệ / tác dụng tâm linh"),
    (r"\bwards?\s+off\b", "hứa hẹn xua đuổi (tâm linh)"),
    (r"\bspiritual\s+(protection|healing|power|energy)\b", "hứa hẹn tác dụng tâm linh"),
    (r"\b(brings?|attracts?)\s+(good\s+)?(luck|fortune|prosperity|abundance)\b", "hứa hẹn may mắn"),
    (r"\bblessed\s+by\b", "gợi ý được ban phước (tâm linh)"),
    (r"\b(sacred|magical?)\s+powers?\b", "hứa hẹn sức mạnh tâm linh"),
]

# Ưu đãi / khan hiếm: chỉ được dùng khi trang sản phẩm có ghi.
OFFER_PATTERNS = [
    (r"\bbuy\s+(\d+|one|two|three|four|five)\s*,?\s*get\s+(\d+|one|two|three)(\s+free)?\b", "ưu đãi mua X tặng Y"),
    (r"\b\d{1,2}\s?%\s*off\b", "giảm giá %"),
    (r"\$\d+(\.\d{2})?\s*off\b", "giảm giá $"),
    (r"\bfree\s+shipping\b", "free shipping"),
    (r"\b(bogo|sale|discount|clearance|coupon|promo\s*code)\b", "giảm giá / khuyến mãi"),
    (r"\bonly\s+\d+\s+(left|remaining)\b", "số lượng còn lại"),
    (r"\b(limited\s+(time|stock|edition|quantities)|while\s+supplies\s+last|selling\s+fast|almost\s+gone|last\s+chance)\b", "khan hiếm / hạn chót"),
    (r"\b(ends?|ending)\s+(today|tonight|soon|at\s+midnight|this\s+week(end)?|sunday|monday)\b", "hạn chót"),
    (r"\b(hurry|act\s+now|don'?t\s+miss\s+out|today\s+only|24\s*hours?\s+only)\b", "thúc giục theo hạn chót"),
]

# Gần đúng \p{Extended_Pictographic} (Python re không có thuộc tính Unicode này).
EMOJI_RE = re.compile(
    "[©®‼⁉™ℹ↔-↙↩↪⌚⌛⌨⏏⏩-⏳⏸-⏺"
    "Ⓜ▪▫▶◀◻-◾☀-➿⤴⤵⬅-⬇⬛⬜⭐⭕"
    "〰〽㊗㊙\U0001F000-\U0001FAFF]"
)


def count_emoji(s: str) -> int:
    return len(EMOJI_RE.findall(s))


def strip_allowed(s: str) -> str:
    for p in ALLOWED_PHRASES:
        s = re.sub(p, " ", s, flags=re.IGNORECASE)
    return s


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower().replace("‘", "'").replace("’", "'"))


def all_caps_sentence(s: str):
    for p in re.split(r"(?<=[.!?])\s+|\n+", s):
        letters = "".join(ch for ch in p if ch.isalpha())
        words = [w for w in p.split() if sum(ch.isalpha() for ch in w) >= 2]
        if len(letters) >= 10 and len(words) >= 2 and letters == letters.upper() and letters != letters.lower():
            return p.strip()
    return None


def check_variant(v: dict, page_text: str) -> list:
    issues = []
    headline = str(v.get("headline", ""))
    primary = str(v.get("primary_text", ""))
    desc = str(v.get("description", ""))
    style = str(v.get("style", ""))
    every = "\n".join([primary, headline, desc])
    scan = strip_allowed(every)

    if style not in STYLES:
        issues.append(f'style "{style}" không thuộc {", ".join(STYLES)}')
    for pattern, why in BANNED:
        m = re.search(pattern, scan, flags=re.IGNORECASE)
        if m:
            issues.append(f'Từ/cụm bị cấm: "{m.group(0)}" — {why}')
    lowered = norm(scan)
    for t in TRIBE_NAMES:
        if re.search(rf"(?<!\w){re.escape(t)}(?!\w)", lowered):
            issues.append(f'Có tên bộ tộc cụ thể: "{t}"')
    for t in TRIBE_NAMES_AMBIGUOUS:
        if re.search(rf"(?<!\w){re.escape(t)}\s+{TRIBE_SUFFIX}(?!\w)", lowered):
            issues.append(f'Có tên bộ tộc cụ thể: "{t}"')
    page = norm(page_text or "")
    for pattern, why in OFFER_PATTERNS:
        m = re.search(pattern, every, flags=re.IGNORECASE)
        if m and norm(m.group(0)) not in page:
            issues.append(f'Nhắc {why} ("{m.group(0)}") nhưng trang sản phẩm không ghi — không tự nghĩ ra ưu đãi/hạn chót')
    caps = all_caps_sentence(every)
    if caps:
        issues.append(f'Có câu viết IN HOA toàn bộ: "{caps[:60]}"')
    e = count_emoji(every)
    if e > 3:
        issues.append(f"Dùng {e} emoji (tối đa 3 mỗi phương án)")

    hl = headline.strip()
    hl_words = len(hl.split())
    if len(hl) > 40:
        issues.append(f"headline dài {len(hl)} ký tự (tối đa 40)")
    if hl_words < 4 or hl_words > 7:
        issues.append(f"headline có {hl_words} từ (cần 4–7 từ)")
    lines = [l.strip() for l in primary.split("\n") if l.strip()]
    if len(lines) < 3 or len(lines) > 6:
        issues.append(f"primary_text có {len(lines)} dòng (cần 3–6 dòng ngắn)")
    hook = re.split(r"(?<=[.!?…])\s", lines[0])[0] if lines else ""
    if len(hook) >= 125:
        issues.append(f"câu hook dài {len(hook)} ký tự (cần dưới 125)")
    d = desc.strip()
    if not d:
        issues.append("description trống")
    elif len(d) >= 30:
        issues.append(f"description dài {len(d)} ký tự (cần dưới 30)")
    return issues


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # console Windows mặc định cp1252 → lỗi khi in tiếng Việt
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    try:
        raw = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else sys.stdin.read()
        data = json.loads(raw)
        variants = data["variants"]
    except Exception as exc:  # đầu vào sai
        print(f"Đầu vào sai: {exc}", file=sys.stderr)
        return 2
    page_text = data.get("page_text", "")
    result = {}
    for i, v in enumerate(variants):
        result[f"V{v.get('variant', i + 1)}"] = check_variant(v, page_text)
    bad = {k: v for k, v in result.items() if v}
    for k, v in result.items():
        print(f"{k}: {'OK' if not v else ''}")
        for issue in v:
            print(f"  - {issue}")
    print(json.dumps({"ok": not bad, "issues": bad}, ensure_ascii=False))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
