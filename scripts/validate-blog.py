#!/usr/bin/env python3
"""Validate the static blog index, article metadata, schemas, and internal links.

Usage:
    python3 scripts/validate-blog.py
    python3 scripts/validate-blog.py --strict

The default mode keeps legacy blog pages visible as warnings while failing on
broken index/sitemap links and malformed metadata or JSON-LD. Use --strict to
make all warnings fail the command as well.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BLOG_DIR = ROOT / "blog"
BLOG_INDEX = ROOT / "blog.html"
SITEMAP = ROOT / "sitemap.xml"
SITE_ORIGIN = "https://strategicflow.tech"

CARD_RE = re.compile(
    r'<a\s+href="(?P<href>/blog/[^"#?]+\.html)"\s+class="article-card">',
    re.IGNORECASE,
)
JSONLD_RE = re.compile(
    r'<script[^>]+type="application/ld\+json"[^>]*>\s*(.*?)\s*</script>',
    re.IGNORECASE | re.DOTALL,
)


class ArticleParser(HTMLParser):
    """Collect only the HTML facts needed by the validator."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.links: list[str] = []
        self.headings: list[str] = []
        self._heading_depth = 0
        self._heading_text: list[str] = []
        self._title_depth = 0
        self._title_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "meta":
            key = attributes.get("name") or attributes.get("property")
            content = attributes.get("content")
            if key and content is not None:
                self.meta[key.lower()] = content.strip()
        elif tag == "link" and attributes.get("rel", "").lower() == "canonical":
            href = attributes.get("href")
            if href:
                self.meta["canonical"] = href.strip()
        elif tag == "a":
            href = attributes.get("href")
            if href:
                self.links.append(href.strip())
        elif tag in {"h2", "h3"}:
            self._heading_depth = 1
            self._heading_text = []
            self._heading_tag = tag
        elif tag == "title":
            self._title_depth = 1
            self._title_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag in {"h2", "h3"} and self._heading_depth:
            self.headings.append(normalise_text(" ".join(self._heading_text)))
            self._heading_depth = 0
            self._heading_text = []
        elif tag == "title" and self._title_depth:
            self.meta["title"] = " ".join(self._title_text).strip()
            self._title_depth = 0
            self._title_text = []

    def handle_data(self, data: str) -> None:
        if self._heading_depth:
            self._heading_text.append(data)
        if self._title_depth:
            self._title_text.append(data)


def normalise_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def add_issue(
    errors: list[str], warnings: list[str], message: str, *, warning: bool = False
) -> None:
    (warnings if warning else errors).append(message)


def published_cards() -> list[str]:
    if not BLOG_INDEX.exists():
        return []
    return CARD_RE.findall(BLOG_INDEX.read_text(encoding="utf-8"))


def local_file_for_url(href: str) -> Path | None:
    parsed = urllib.parse.urlparse(href)
    if parsed.scheme and parsed.netloc and parsed.netloc != "strategicflow.tech":
        return None
    path = urllib.parse.unquote(parsed.path).lstrip("/")
    if not path:
        return ROOT / "index.html"
    candidate = ROOT / path
    if candidate.is_file():
        return candidate
    if not path.endswith("/"):
        html_candidate = ROOT / f"{path}.html"
        if html_candidate.is_file():
            return html_candidate
    if path.endswith("/"):
        index_candidate = ROOT / path / "index.html"
        if index_candidate.is_file():
            return index_candidate
    return None


def validate_metadata(
    filename: str,
    parser: ArticleParser,
    expected_url: str,
    is_field_note: bool,
    errors: list[str],
    warnings: list[str],
) -> None:
    required = {
        "title": "title",
        "description": "name=\"description\"",
        "og:type": "property=\"og:type\"",
        "og:title": "property=\"og:title\"",
        "og:description": "property=\"og:description\"",
        "og:url": "property=\"og:url\"",
        "og:site_name": "property=\"og:site_name\"",
        "twitter:card": "name=\"twitter:card\"",
        "twitter:title": "name=\"twitter:title\"",
        "twitter:description": "name=\"twitter:description\"",
        "canonical": "rel=\"canonical\"",
    }
    for key, label in required.items():
        if not parser.meta.get(key):
            add_issue(
                errors,
                warnings,
                f"{filename}: missing {label}",
                warning=not is_field_note,
            )

    canonical = parser.meta.get("canonical")
    if canonical and canonical != expected_url:
        add_issue(
            errors,
            warnings,
            f"{filename}: canonical is {canonical!r}, expected {expected_url!r}",
            warning=not is_field_note,
        )
    og_url = parser.meta.get("og:url")
    if og_url and og_url != expected_url:
        add_issue(
            errors,
            warnings,
            f"{filename}: og:url is {og_url!r}, expected {expected_url!r}",
            warning=not is_field_note,
        )

    # These fields are part of the current Field Note template but some
    # historical articles predate them, so they are warnings by default.
    for key, label in {
        "keywords": "name=\"keywords\"",
        "robots": "name=\"robots\"",
    }.items():
        if not parser.meta.get(key):
            add_issue(errors, warnings, f"{filename}: missing {label}", warning=True)


def validate_jsonld(
    filename: str,
    source: str,
    parser: ArticleParser,
    is_field_note: bool,
    errors: list[str],
    warnings: list[str],
) -> None:
    blocks = JSONLD_RE.findall(source)
    parsed: list[dict] = []
    for index, block in enumerate(blocks, start=1):
        try:
            value = json.loads(block)
        except json.JSONDecodeError as exc:
            add_issue(errors, warnings, f"{filename}: invalid JSON-LD block {index}: {exc}")
            continue
        if isinstance(value, dict):
            parsed.append(value)

    types = {item.get("@type") for item in parsed}
    article_type_present = bool(types & {"Article", "BlogPosting"})
    for required_type in ("BreadcrumbList",):
        if required_type not in types:
            add_issue(
                errors,
                warnings,
                f"{filename}: missing JSON-LD {required_type}",
                warning=not is_field_note,
            )
    if not article_type_present:
        add_issue(
            errors,
            warnings,
            f"{filename}: missing JSON-LD Article or BlogPosting",
            warning=not is_field_note,
        )
    if "FAQPage" not in types:
        add_issue(
            errors,
            warnings,
            f"{filename}: missing JSON-LD FAQPage",
            warning=not is_field_note,
        )

    faq = next((item for item in parsed if item.get("@type") == "FAQPage"), None)
    if not faq:
        return
    questions = faq.get("mainEntity", [])
    question_names = [
        normalise_text(item.get("name", ""))
        for item in questions
        if isinstance(item, dict) and item.get("name")
    ]
    heading_names = set(parser.headings)
    for question in question_names:
        if question not in heading_names:
            add_issue(
                errors,
                warnings,
                f"{filename}: FAQ question has no matching on-page heading: {question}",
                warning=not is_field_note,
            )


def validate_field_note_template(
    filename: str, source: str, parser: ArticleParser, errors: list[str]
) -> None:
    required_markers = {
        "What Happened": "What Happened",
        "The Pattern": "The Pattern",
        "The Rebuild": "The Rebuild",
        "Questions people ask": "Questions people ask",
        "Related reading": "Related reading",
        "Pattern terms": "Pattern terms",
        "sticky affiliate bar": 'id="sf-sticky-bar"',
        "cookie banner": 'id="cookie-banner"',
        "mobile menu": 'class="mobile-menu"',
    }
    for label, marker in required_markers.items():
        if marker not in source and normalise_text(marker) not in parser.headings:
            errors.append(f"{filename}: Field Note template is missing {label}")


def validate_index_and_sitemap(
    cards: list[str],
    field_note_files: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    if not BLOG_INDEX.exists():
        errors.append("blog.html: file does not exist")
        return
    if not SITEMAP.exists():
        errors.append("sitemap.xml: file does not exist")
        return

    card_counts = Counter(cards)
    for href, count in card_counts.items():
        if count > 1:
            add_issue(
                errors,
                warnings,
                f"blog.html: {href} appears {count} times",
                warning=True,
            )

    for href in sorted(card_counts):
        filename = Path(urllib.parse.urlparse(href).path).name
        if not (BLOG_DIR / filename).is_file():
            errors.append(f"blog.html: card points to missing file {href}")

    try:
        sitemap_root = ET.parse(SITEMAP).getroot()
    except ET.ParseError as exc:
        errors.append(f"sitemap.xml: invalid XML: {exc}")
        return

    sitemap_urls = [
        element.text.strip()
        for element in sitemap_root.iter()
        if element.tag.rsplit("}", 1)[-1] == "loc" and element.text
    ]
    sitemap_counts = Counter(sitemap_urls)
    for href in sorted(card_counts):
        expected = f"{SITE_ORIGIN}{href}"
        count = sitemap_counts.get(expected, 0)
        filename = Path(urllib.parse.urlparse(href).path).name
        if count == 0:
            add_issue(
                errors,
                warnings,
                f"sitemap.xml: missing {expected}",
                warning=filename not in field_note_files,
            )
        elif count > 1:
            errors.append(f"sitemap.xml: {expected} appears {count} times")


def validate_internal_links(
    filename: str,
    parser: ArticleParser,
    is_field_note: bool,
    errors: list[str],
    warnings: list[str],
) -> None:
    for href in parser.links:
        parsed = urllib.parse.urlparse(href)
        if parsed.netloc not in {"", "strategicflow.tech"}:
            continue
        if parsed.scheme not in {"", "https"}:
            continue
        if local_file_for_url(href) is None:
            add_issue(
                errors,
                warnings,
                f"{filename}: internal link does not resolve: {href}",
                warning=not is_field_note,
            )


def main() -> int:
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument(
        "--strict",
        action="store_true",
        help="Treat legacy warnings, including duplicate cards, as errors.",
    )
    args.add_argument(
        "--verbose",
        action="store_true",
        help="Print every legacy warning instead of only the warning count.",
    )
    options = args.parse_args()

    errors: list[str] = []
    warnings: list[str] = []
    cards = published_cards()
    field_note_files = {
        path.name
        for path in BLOG_DIR.glob("*.html")
        if 'class="article-tag">Field Note' in path.read_text(encoding="utf-8")
    }
    validate_index_and_sitemap(cards, field_note_files, errors, warnings)

    if not cards:
        errors.append("blog.html: no article cards found")

    for href in sorted(set(cards)):
        filename = Path(urllib.parse.urlparse(href).path).name
        article_path = BLOG_DIR / filename
        if not article_path.is_file():
            continue
        source = article_path.read_text(encoding="utf-8")
        parser = ArticleParser()
        parser.feed(source)
        expected_url = f"{SITE_ORIGIN}/blog/{filename}"
        is_field_note = "class=\"article-tag\">Field Note" in source
        validate_metadata(
            filename, parser, expected_url, is_field_note, errors, warnings
        )
        validate_jsonld(filename, source, parser, is_field_note, errors, warnings)
        if is_field_note:
            validate_field_note_template(filename, source, parser, errors)
        validate_internal_links(filename, parser, is_field_note, errors, warnings)

    print(f"Checked {len(set(cards))} published article files and {len(cards)} cards.")
    if errors:
        print("\nErrors:")
        for issue in errors:
            print(f"  - {issue}")
    if warnings and (options.verbose or options.strict):
        print("\nWarnings:")
        for issue in warnings:
            print(f"  - {issue}")
    elif warnings:
        print(
            f"\nWarnings: {len(warnings)} legacy item(s) found. "
            "Use --verbose for the full report."
        )

    if options.strict and warnings:
        errors.extend(f"[strict] {issue}" for issue in warnings)
    if errors:
        print(f"\nFAILED: {len(errors)} error(s), {len(warnings)} warning(s).")
        return 1
    print(f"\nPASSED: {len(warnings)} warning(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())