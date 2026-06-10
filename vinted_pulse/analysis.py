"""Listing analysis.

Two parts:
  * analyze_description — free, instant heuristics over the listing text
    (length, measurements, condition words, flavour words, hashtags, emoji).
    Word lists cover English and Swedish.
  * analyze_photo — Claude vision (claude-opus-4-8) classifies how and where
    the first photo was taken. Costs API tokens, so it runs on demand via the
    `analyze` command rather than on every poll.
"""

from __future__ import annotations

import base64
import re
from typing import Literal

# -- description heuristics --------------------------------------------------

MEASUREMENT_RE = re.compile(
    r"""
    \b\d+([.,]\d+)?\s*(cm|mm|inch|inches|in|tum)\b   # 52 cm, 20.5 in
    | \bp(it)?\s*(2|to)\s*p(it)?\b                   # pit to pit, p2p, ptp
    | \b(chest|shoulder|sleeve|length|width|waist|inseam)\s*[:\-]?\s*\d+
    | \b(bröst|axel|ärm|längd|bredd|midja|innerben)\s*[:\-]?\s*\d+
    """,
    re.IGNORECASE | re.VERBOSE,
)

CONDITION_WORDS = [
    # English
    "new with tags", "nwt", "nwot", "brand new", "like new", "barely worn",
    "worn once", "great condition", "good condition", "excellent condition",
    "no flaws", "no stains", "no holes", "deadstock",
    # Swedish
    "nyskick", "oanvänd", "aldrig använd", "använd en gång", "mycket gott skick",
    "gott skick", "bra skick", "fint skick", "inga fläckar", "inga hål", "som ny",
]

FLAVOUR_WORDS = [
    # English
    "stunning", "gorgeous", "beautiful", "amazing", "classic", "timeless",
    "iconic", "elegant", "rare", "vintage", "retro", "perfect", "lovely",
    "premium", "luxurious", "stylish", "must have", "wardrobe staple",
    "effortless", "versatile", "preppy", "crisp",
    # Swedish
    "snygg", "vacker", "underbar", "klassisk", "tidlös", "ikonisk", "elegant",
    "sällsynt", "perfekt", "härlig", "stilren", "exklusiv", "somrig", "fräsch",
]

EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF❤️]"
)


def analyze_description(text: str | None) -> dict:
    text = (text or "").strip()
    lower = text.lower()
    words = re.findall(r"\w+", lower, re.UNICODE)
    word_count = len(words)

    if word_count == 0:
        length_class = "empty"
    elif word_count < 25:
        length_class = "short"
    elif word_count <= 80:
        length_class = "medium"
    else:
        length_class = "long"

    flavour_found = sorted({w for w in FLAVOUR_WORDS if w in lower})
    condition_found = sorted({w for w in CONDITION_WORDS if w in lower})

    return {
        "char_count": len(text),
        "word_count": word_count,
        "line_count": text.count("\n") + 1 if text else 0,
        "length_class": length_class,
        "has_measurements": bool(MEASUREMENT_RE.search(text)),
        "mentions_size": bool(re.search(r"\b(size|storlek|stl)\b", lower)),
        "mentions_condition": bool(condition_found),
        "condition_words": condition_found,
        "flavour_word_count": len(flavour_found),
        "flavour_words": flavour_found,
        "has_hashtags": "#" in text,
        "has_emoji": bool(EMOJI_RE.search(text)),
    }


# -- photo analysis via Claude ------------------------------------------------

PHOTO_PROMPT = (
    "This is the first (cover) photo of a second-hand clothing listing on Vinted. "
    "Classify how and where it was shot. Judge it the way a buyer scrolling "
    "search results would."
)


def _photo_schema():
    """Pydantic model for structured photo analysis. Defined lazily so the
    anthropic/pydantic imports are only needed when photo analysis runs."""
    from pydantic import BaseModel, Field

    class PhotoAnalysis(BaseModel):
        presentation: Literal[
            "flat_lay", "hanging", "worn_on_person", "mannequin",
            "folded", "stock_photo", "other",
        ] = Field(description="How the garment is presented")
        location: Literal[
            "bed_or_sofa", "floor", "plain_backdrop", "wall_or_door",
            "outdoors", "studio_or_store", "cluttered_room", "other",
        ] = Field(description="Where the photo appears to be taken")
        lighting: Literal["bright_natural", "bright_artificial", "dim", "harsh_flash"]
        garment_fills_frame: bool = Field(
            description="Garment is large and centered, not a small part of the frame"
        )
        background_clutter: bool = Field(
            description="Distracting objects visible around the garment"
        )
        quality_score: Literal[1, 2, 3, 4, 5] = Field(
            description="Overall photo quality for selling, 1=poor 5=excellent"
        )
        summary: str = Field(description="One short sentence describing the shot")

    return PhotoAnalysis


def analyze_photo(image_bytes: bytes, media_type: str) -> dict:
    """Classify a listing photo with Claude vision. Requires ANTHROPIC_API_KEY."""
    import anthropic

    schema = _photo_schema()
    client = anthropic.Anthropic()
    response = client.messages.parse(
        model="claude-opus-4-8",
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": base64.standard_b64encode(image_bytes).decode("utf-8"),
                        },
                    },
                    {"type": "text", "text": PHOTO_PROMPT},
                ],
            }
        ],
        output_format=schema,
    )
    return response.parsed_output.model_dump()
