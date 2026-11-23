#!/usr/bin/env python3
"""Safely check official competitor pricing pages and update the static page."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.parsers.expat
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "competitor-prices.json"
PAGE_PATH = ROOT / "free-pre-send-check.html"
SITEMAP_PATH = ROOT / "sitemap.xml"
MAX_RESPONSE_BYTES = 2_000_000
USER_AGENT = "StrategicFlowCompetitorPriceCheck/1.0 (+https://strategicflow.tech)"

MAILGUN_URL = "https://www.mailgun.com/pricing/inspect/"
LITMUS_URL = "https://www.litmus.com/pricing-litmus"
EMAIL_ON_ACID_URL = "https://www.emailonacid.com/plans-pricing/"
LITMUS_CONTACT_URL = "https://www.litmus.com/contact-sales"
TRANSITION_URL = "https://www.mailgun.com/blog/product/mailgun-inspect-next-generation/"


class ReviewRequired(Exception):
    """The source could not be read confidently enough to publish a change."""


class VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_tags: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self.skip_tags.append(tag)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.skip_tags) - 1, -1, -1):
            if self.skip_tags[index] == tag:
                del self.skip_tags[index:]
                break

    def handle_data(self, data: str) -> None:
        if not self.skip_tags and data.strip():
            self.parts.append(" ".join(data.split()))


def visible_text(source: str) -> str:
    parser = VisibleTextParser()
    parser.feed(source)
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


def fetch_page(url: str) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(3):
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise ReviewRequired(f"Source response exceeded {MAX_RESPONSE_BYTES} bytes: {url}")
                charset = response.headers.get_content_charset() or "utf-8"
                return {
                    "requested_url": url,
                    "status": response.status,
                    "final_url": response.geturl(),
                    "text": body.decode(charset, errors="replace"),
                }
        except urllib.error.HTTPError as error:
            body = error.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ReviewRequired(f"Source response exceeded {MAX_RESPONSE_BYTES} bytes: {url}")
            if error.code >= 500 and attempt < 2:
                last_error = error
                time.sleep(1 + attempt)
                continue
            charset = error.headers.get_content_charset() if error.headers else None
            return {
                "requested_url": url,
                "status": error.code,
                "final_url": error.geturl(),
                "text": body.decode(charset or "utf-8", errors="replace"),
            }
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(1 + attempt)
                continue
    raise ReviewRequired(f"Could not fetch {url}: {last_error}")


def normalize_amount(value: str) -> str:
    try:
        amount = Decimal(value.replace(",", ""))
    except InvalidOperation as error:
        raise ReviewRequired(f"Could not parse a price amount: {value}") from error
    if amount < 0:
        raise ReviewRequired("A negative listed price is not supported.")
    normalized = format(amount, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized


def _mailgun_plan_prices(text: str, plan: str) -> list[str]:
    pattern = re.compile(
        rf"\b{plan}\s+(?:Free\s+for\s+(?:your\s+)?(?:\d+|first|one|a)\s+month,\s+then\s+)?"
        rf"\$\s*(\d[\d,]*(?:\.\d{{1,2}})?)\s*/\s*mo(?:nth)?\b",
        re.IGNORECASE,
    )
    return [normalize_amount(value) for value in pattern.findall(text)]


def _mailgun_features(text: str, plan: str) -> tuple[bool, bool]:
    marker = f"What's included on {plan}"
    if len(re.findall(re.escape(marker), text, re.IGNORECASE)) != 1:
        raise ReviewRequired(f"Expected one visible '{marker}' section on Mailgun's page.")
    start = re.search(re.escape(marker), text, re.IGNORECASE)
    assert start is not None
    end = re.search(r"\bOverages\b", text[start.end():], re.IGNORECASE)
    if end is None:
        raise ReviewRequired(f"Could not find the end of Mailgun's {plan} feature section.")
    section = text[start.end():start.end() + end.start()]
    link_excluded = re.search(
        r"(?:image\s*&\s*)?link validation\s*\(\s*not included\s*\)",
        section,
        re.IGNORECASE,
    )
    spam_excluded = re.search(
        r"spam content analysis\s*\(\s*not included\s*\)",
        section,
        re.IGNORECASE,
    )
    link_mentioned = re.search(r"\blink validation\b", section, re.IGNORECASE)
    spam_mentioned = re.search(r"\bspam content analysis\b", section, re.IGNORECASE)
    if not link_mentioned or not spam_mentioned:
        raise ReviewRequired(f"Mailgun's {plan} feature list no longer clearly identifies both checks.")
    if plan.lower() == "basic":
        if not link_excluded or not spam_excluded:
            raise ReviewRequired("Mailgun Basic's exclusions are not explicit in the expected section.")
        return False, False
    if link_excluded or spam_excluded:
        raise ReviewRequired("Mailgun Premium's included checks appear to have changed or become ambiguous.")
    return True, True


def _trial_months(text: str) -> int:
    if re.search(
        r"\bFree\s+for\s+(?:your\s+)?(?:\d+|first|second|third|one|a)\s+(?:days?|weeks?)\b",
        text,
        re.IGNORECASE,
    ):
        raise ReviewRequired("Mailgun's free-trial unit is no longer months.")
    matches = re.findall(
        r"\bFree\s+for\s+(?:your\s+)?(\d+|first|second|third|one|a)\s+months?\b",
        text,
        re.IGNORECASE,
    )
    if not matches:
        raise ReviewRequired("Could not identify Mailgun's free-trial duration.")
    words = {"first": 1, "second": 2, "third": 3, "one": 1, "a": 1}
    values = {int(value) if value.isdigit() else words[value.lower()] for value in matches}
    if len(values) != 1:
        raise ReviewRequired(f"Mailgun's free-trial duration is inconsistent: {sorted(values)}")
    return values.pop()


def extract_mailgun(page: dict[str, Any]) -> dict[str, Any]:
    final = urllib.parse.urlparse(page["final_url"])
    if page["status"] != 200 or final.hostname != "www.mailgun.com" or final.path.rstrip("/") != "/pricing/inspect":
        raise ReviewRequired(
            f"Mailgun pricing source returned HTTP {page['status']} at {page['final_url']}."
        )
    text = visible_text(page["text"])
    basic_prices = _mailgun_plan_prices(text, "Basic")
    premium_prices = _mailgun_plan_prices(text, "Premium")
    if len(basic_prices) < 2 or len(set(basic_prices)) != 1:
        raise ReviewRequired(f"Mailgun Basic prices were not repeated consistently: {basic_prices}")
    if len(premium_prices) < 2 or len(set(premium_prices)) != 1:
        raise ReviewRequired(f"Mailgun Premium prices were not repeated consistently: {premium_prices}")
    basic_features = _mailgun_features(text, "Basic")
    premium_features = _mailgun_features(text, "Premium")
    trial_months = _trial_months(text)
    return {
        "basic": {
            "monthly_usd": basic_prices[0],
            "free_trial_months": trial_months,
            "link_validation": basic_features[0],
            "spam_checks": basic_features[1],
        },
        "premium": {
            "monthly_usd": premium_prices[0],
            "free_trial_months": trial_months,
            "link_validation": premium_features[0],
            "spam_checks": premium_features[1],
        },
    }


def extract_litmus(page: dict[str, Any]) -> dict[str, Any]:
    final = urllib.parse.urlparse(page["final_url"])
    if page["status"] != 200 or final.hostname != "www.litmus.com":
        raise ReviewRequired(f"Litmus source returned HTTP {page['status']} at {page['final_url']}.")
    text = visible_text(page["text"])
    currency_re = re.compile(r"[$€£]\s*\d[\d,.]*")
    monthly_re = re.compile(
        r"(?P<currency>[$€£])\s*(?P<amount>\d[\d,]*(?:\.\d{1,2})?)"
        r"\s*(?:/\s*mo(?:nth)?\b|per\s+month\b|a\s+month\b)",
        re.IGNORECASE,
    )
    monthly_matches = list(monthly_re.finditer(text))
    all_money = list(currency_re.finditer(text))
    if len(all_money) != len(monthly_matches):
        raise ReviewRequired("Litmus shows a price without a clear monthly unit, or a monthly price was not parsed.")

    if monthly_matches:
        plan_re = re.compile(
            r"\b(Basic|Plus|Premium|Standard|Professional|Business|Enterprise|Starter|Essentials|Core)\b",
            re.IGNORECASE,
        )
        prices: dict[str, dict[str, str]] = {}
        for match in monthly_matches:
            prefix = text[max(0, match.start() - 80):match.start()]
            labels = list(plan_re.finditer(prefix))
            if not labels:
                raise ReviewRequired("A Litmus monthly price was found without a nearby named plan.")
            plan = labels[-1].group(1)
            key = plan.casefold()
            currency = {"$": "USD", "€": "EUR", "£": "GBP"}[match.group("currency")]
            item = {"plan": plan, "amount": normalize_amount(match.group("amount")), "currency": currency}
            if key in prices and prices[key] != item:
                raise ReviewRequired(f"Litmus lists conflicting prices for {plan}.")
            prices[key] = item
        ordered = sorted(prices.values(), key=lambda item: item["plan"].casefold())
        summary = "Pricing is published: " + ", ".join(
            f"{item['plan']}: { {'USD': '$', 'EUR': '€', 'GBP': '£'}[item['currency']] }"
            f"{item['amount']}/month"
            for item in ordered
        ) + "."
        return {
            "pricing_published": True,
            "contact_sales_required": False,
            "prices": ordered,
            "pricing_summary": summary,
            "final_url": page["final_url"],
        }

    if all_money or "/contact-sales" not in final.path.rstrip("/"):
        raise ReviewRequired("Litmus pricing availability is not clear from its current page.")
    return {
        "pricing_published": False,
        "contact_sales_required": True,
        "prices": [],
        "pricing_summary": "Pricing is not published on the page; sales contact is required.",
        "final_url": page["final_url"],
    }


def extract_email_on_acid(page: dict[str, Any]) -> dict[str, Any]:
    text = visible_text(page["text"]).casefold()
    final = urllib.parse.urlparse(page["final_url"])
    if (
        page["status"] == 404
        and "page not found" in text
        and "mailgun inspect" in text
        and final.hostname == "www.emailonacid.com"
    ):
        state = "unavailable"
    else:
        raise ReviewRequired(
            f"Email on Acid's legacy pricing page changed or is unclear: "
            f"HTTP {page['status']} at {page['final_url']}."
        )
    return {
        "legacy_pricing_url_status": page["status"],
        "state": state,
        "final_url": page["final_url"],
    }


def trial_phrase(months: int, *, hero: bool = False) -> str:
    if months == 1:
        return "after its free month" if hero else "after the first free month"
    if hero:
        return f"after its {months}-month free trial"
    return f"after a {months}-month free trial"


def feature_summary(plan: dict[str, Any], *, basic: bool) -> str:
    link = plan["link_validation"]
    spam = plan["spam_checks"]
    if link and spam:
        return "Includes link validation and spam content checks."
    if not link and not spam and basic:
        return "Basic does not include link validation or spam content checks."
    statements = []
    statements.append("Includes link validation" if link else "Link validation is not included")
    statements.append("spam content checks" if spam else "spam content checks are not included")
    return "; ".join(statements) + "."


def format_competitor_faq(data: dict[str, Any]) -> str:
    basic = data["mailgun"]["basic"]
    premium = data["mailgun"]["premium"]
    basic_trial = trial_phrase(basic["free_trial_months"])
    premium_trial = trial_phrase(premium["free_trial_months"])
    litmus = (
        data["litmus"]["pricing_summary"]
        if data["litmus"]["pricing_published"]
        else "Litmus pricing is not published on its pricing page, which requires contacting sales."
    )
    if basic["link_validation"] and basic["spam_checks"]:
        basic_checks = "includes link validation and spam content checks"
    elif basic["link_validation"]:
        basic_checks = "includes link validation but not spam content checks"
    elif basic["spam_checks"]:
        basic_checks = "includes spam content checks but not link validation"
    else:
        basic_checks = "does not include those checks"
    if premium["link_validation"] and premium["spam_checks"]:
        premium_checks = "includes link validation and spam content checks"
    elif premium["link_validation"]:
        premium_checks = "includes link validation but not spam content checks"
    elif premium["spam_checks"]:
        premium_checks = "includes spam content checks but not link validation"
    else:
        premium_checks = "does not include link validation or spam content checks"
    verified_date = dt.date.fromisoformat(data["last_verified"])
    date = f"{verified_date.day} {verified_date.strftime('%b %Y')}"
    return (
        "This free checker covers only the checks listed on this page and does not provide email-client "
        "previews or the Decision Friction Model audit. Mailgun Inspect Premium is listed at "
        f"${premium['monthly_usd']} per month {premium_trial} and {premium_checks}; "
        f"its Basic plan is ${basic['monthly_usd']} per month {basic_trial} and {basic_checks}. "
        f"{litmus} Mailgun's official transition announcement says Inspect succeeds Email on Acid; "
        "the former Email on Acid pricing URL is currently unavailable, so older Email on Acid prices are "
        "not repeated here. Prices as listed on their official pricing pages, "
        f"{date}."
    )


def html_slot_values(data: dict[str, Any]) -> dict[str, str]:
    basic = data["mailgun"]["basic"]
    premium = data["mailgun"]["premium"]
    date = dt.date.fromisoformat(data["last_verified"])
    date_long = f"{date.day} {date.strftime('%b %Y')}"
    return {
        "premium_hero_phrase": (
            f"${premium['monthly_usd']} a month "
            f"{trial_phrase(premium['free_trial_months'], hero=True)}"
        ),
        "source_date_stamp": f"{date.day} {date.strftime('%b %Y')}".upper(),
        "source_date_long": date_long,
        "basic_monthly_price": f"${basic['monthly_usd']}/mo",
        "premium_monthly_price": f"${premium['monthly_usd']}/mo",
        "basic_trial_phrase": trial_phrase(basic["free_trial_months"]),
        "premium_trial_phrase": trial_phrase(premium["free_trial_months"]),
        "basic_feature_summary": feature_summary(basic, basic=True),
        "premium_feature_summary": feature_summary(premium, basic=False),
        "litmus_price_summary": data["litmus"]["pricing_summary"],
        "competitor_faq": format_competitor_faq(data),
        "last_updated": data["last_verified"],
    }


class PriceMarkupParser(HTMLParser):
    """Locate marked text slots while retaining all unrelated source formatting."""

    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_offsets = [0]
        for match in re.finditer("\n", source):
            self.line_offsets.append(match.end())
        self.open_slots: list[dict[str, Any]] = []
        self.slots: dict[str, list[tuple[int, int]]] = {}
        self.json_start: int | None = None
        self.json_ranges: list[tuple[int, int]] = []

    def source_offset(self) -> int:
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = dict(attrs)
        tag_text = self.get_starttag_text() or ""
        tag_start = self.source_offset()
        if self.open_slots:
            self.open_slots[-1]["nested"] = True
        slot = attrs_map.get("data-price-slot")
        if slot:
            self.open_slots.append(
                {
                    "name": slot,
                    "tag": tag,
                    "content_start": tag_start + len(tag_text),
                    "nested": False,
                }
            )
        if tag == "script" and "data-competitor-price-jsonld" in attrs_map:
            if self.json_start is not None or self.json_ranges:
                raise ReviewRequired("Expected exactly one marked competitor JSON-LD block.")
            self.json_start = tag_start + len(tag_text)

    def handle_endtag(self, tag: str) -> None:
        tag_start = self.source_offset()
        if self.open_slots and self.open_slots[-1]["tag"] == tag:
            slot = self.open_slots.pop()
            if slot["nested"]:
                raise ReviewRequired(f"Price slot '{slot['name']}' contains nested markup.")
            self.slots.setdefault(slot["name"], []).append((slot["content_start"], tag_start))
        if tag == "script" and self.json_start is not None:
            self.json_ranges.append((self.json_start, tag_start))
            self.json_start = None


def _faq_answer(schema: dict[str, Any]) -> tuple[dict[str, Any], str]:
    graph = schema.get("@graph", [])
    faq = next(
        (item for item in graph if item.get("@type") == "FAQPage"),
        None,
    )
    if faq is None:
        raise ReviewRequired("Could not find the FAQPage in the marked JSON-LD.")
    questions = faq.get("mainEntity", [])
    target = next(
        (
            item for item in questions
            if item.get("name") == "How is this different from Email on Acid, Litmus, or Mailgun Inspect?"
        ),
        None,
    )
    if target is None:
        raise ReviewRequired("Could not find the competitor FAQ in the JSON-LD.")
    return target, target["acceptedAnswer"]["text"]


def _replace_jsonld_faq_answer(script: str, new_answer: str) -> str:
    try:
        schema = json.loads(script)
    except json.JSONDecodeError as error:
        raise ReviewRequired(f"Could not parse the marked JSON-LD block: {error}") from error
    _target, old_answer = _faq_answer(schema)
    old_literal = json.dumps(old_answer, ensure_ascii=False)
    new_literal = json.dumps(new_answer, ensure_ascii=False)
    if script.count(old_literal) != 1:
        raise ReviewRequired("Could not safely isolate the competitor FAQ answer in the JSON-LD source.")
    return script.replace(old_literal, new_literal, 1)


def replace_faq_date(answer: str, date: str) -> str:
    marker = "Prices as listed on their official pricing pages, "
    if answer.count(marker) != 1:
        raise ReviewRequired("Could not safely locate the checked date in the competitor FAQ.")
    start = answer.index(marker) + len(marker)
    tail = answer[start:]
    if not re.fullmatch(r"\d{1,2} [A-Za-z]{3} \d{4}\.", tail):
        raise ReviewRequired("The competitor FAQ date has unexpected surrounding text.")
    return answer[:start] + date + "."


def render_page(source: str, data: dict[str, Any]) -> str:
    parser = PriceMarkupParser(source)
    parser.feed(source)
    if parser.open_slots or len(parser.json_ranges) != 1:
        raise ReviewRequired("The page's marked price slots or JSON-LD block are incomplete.")
    values = html_slot_values(data)
    missing = sorted(set(values) - set(parser.slots))
    if missing:
        raise ReviewRequired(f"Page is missing required price/date slots: {', '.join(missing)}")
    replacements: list[tuple[int, int, str]] = []
    for name, value in values.items():
        for start, end in parser.slots[name]:
            original = source[start:end]
            if "<" in original or ">" in original:
                raise ReviewRequired(f"Price slot '{name}' is not plain text.")
            replacements.append((start, end, html.escape(value, quote=False)))
    json_start, json_end = parser.json_ranges[0]
    json_script = _replace_jsonld_faq_answer(
        source[json_start:json_end],
        format_competitor_faq(data),
    )
    replacements.append((json_start, json_end, json_script))
    rendered = source
    for start, end, replacement in sorted(replacements, reverse=True):
        rendered = rendered[:start] + replacement + rendered[end:]
    return rendered


def render_page_date_only(source: str, current_data: dict[str, Any], date: str) -> str:
    """Update only the visible dates, the FAQ's checked date, and its JSON-LD twin."""
    parser = PriceMarkupParser(source)
    parser.feed(source)
    if parser.open_slots or len(parser.json_ranges) != 1:
        raise ReviewRequired("The page's marked price slots or JSON-LD block are incomplete.")
    expected = html_slot_values(current_data)
    date_slots = {"source_date_stamp", "source_date_long", "last_updated"}
    for name, expected_value in expected.items():
        ranges = parser.slots.get(name, [])
        if not ranges:
            raise ReviewRequired(f"Page is missing required price/date slot: {name}")
        if name in date_slots or name == "competitor_faq":
            continue
        if any(html.unescape(source[start:end]) != expected_value for start, end in ranges):
            raise ReviewRequired(f"Displayed page value in '{name}' differs from the verified data file.")

    date_value = dt.date.fromisoformat(date)
    date_long = f"{date_value.day} {date_value.strftime('%b %Y')}"
    date_stamp = f"{date_value.day} {date_value.strftime('%b %Y')}".upper()
    replacements: list[tuple[int, int, str]] = []
    date_replacements = {
        "source_date_stamp": date_stamp,
        "source_date_long": date_long,
        "last_updated": date,
    }
    for name, value in date_replacements.items():
        ranges = parser.slots[name]
        if len(ranges) != 1:
            raise ReviewRequired(f"Expected one '{name}' date slot, found {len(ranges)}.")
        start, end = ranges[0]
        replacements.append((start, end, html.escape(value, quote=False)))

    faq_ranges = parser.slots["competitor_faq"]
    if len(faq_ranges) != 1:
        raise ReviewRequired("Expected one visible competitor FAQ answer.")
    faq_start, faq_end = faq_ranges[0]
    current_faq = html.unescape(source[faq_start:faq_end])
    expected_faq = format_competitor_faq(current_data)
    if current_faq != expected_faq:
        raise ReviewRequired("Visible competitor facts differ from competitor-prices.json; date-only update stopped.")
    replacements.append(
        (
            faq_start,
            faq_end,
            html.escape(replace_faq_date(current_faq, date_long), quote=False),
        )
    )

    json_start, json_end = parser.json_ranges[0]
    try:
        schema = json.loads(source[json_start:json_end])
    except json.JSONDecodeError as error:
        raise ReviewRequired(f"Could not parse the marked JSON-LD block: {error}") from error
    _target, current_answer = _faq_answer(schema)
    if current_answer != expected_faq:
        raise ReviewRequired("JSON-LD competitor facts differ from competitor-prices.json; date-only update stopped.")
    replacements.append(
        (
            json_start,
            json_end,
            _replace_jsonld_faq_answer(
                source[json_start:json_end],
                replace_faq_date(current_answer, date_long),
            ),
        )
    )
    rendered = source
    for start, end, replacement in sorted(replacements, reverse=True):
        rendered = rendered[:start] + replacement + rendered[end:]
    return rendered


def _locate_sitemap_lastmod(source: bytes, target_url: str) -> tuple[int, int]:
    parser = xml.parsers.expat.ParserCreate()
    in_url = False
    current_field: str | None = None
    loc_parts: list[str] = []
    lastmod_range: tuple[int, int] | None = None
    matches: list[tuple[int, int]] = []

    def start(name: str, _attrs: dict[str, str]) -> None:
        nonlocal in_url, current_field, loc_parts, lastmod_range
        if name == "url":
            in_url = True
            current_field = None
            loc_parts = []
            lastmod_range = None
        elif in_url and name in {"loc", "lastmod"}:
            current_field = name
            if name == "loc":
                loc_parts = []

    def character_data(value: str) -> None:
        nonlocal lastmod_range
        if not in_url:
            return
        if current_field == "loc":
            loc_parts.append(value)
        elif current_field == "lastmod" and value:
            start_index = parser.CurrentByteIndex
            end_index = start_index + len(value.encode("utf-8"))
            if lastmod_range is None:
                lastmod_range = (start_index, end_index)
            else:
                lastmod_range = (lastmod_range[0], end_index)

    def end(name: str) -> None:
        nonlocal in_url, current_field, lastmod_range
        if name in {"loc", "lastmod"}:
            current_field = None
        elif name == "url":
            if "".join(loc_parts).strip() == target_url and lastmod_range:
                matches.append(lastmod_range)
            in_url = False
            current_field = None
            lastmod_range = None

    parser.StartElementHandler = start
    parser.CharacterDataHandler = character_data
    parser.EndElementHandler = end
    try:
        parser.Parse(source, True)
    except xml.parsers.expat.ExpatError as error:
        raise ReviewRequired(f"Sitemap XML is invalid: {error}") from error
    if len(matches) != 1:
        raise ReviewRequired(f"Expected one sitemap entry for {target_url}; found {len(matches)}.")
    return matches[0]


def render_sitemap(source: bytes, date: str) -> bytes:
    start, end = _locate_sitemap_lastmod(
        source,
        "https://strategicflow.tech/free-pre-send-check.html",
    )
    return source[:start] + date.encode("ascii") + source[end:]


def _price_snapshot(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "mailgun_basic_usd": data["mailgun"]["basic"]["monthly_usd"],
        "mailgun_premium_usd": data["mailgun"]["premium"]["monthly_usd"],
        "litmus_published": data["litmus"]["pricing_published"],
        "litmus_prices": data["litmus"]["prices"],
    }


def _non_price_snapshot(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "mailgun_basic_trial": data["mailgun"]["basic"]["free_trial_months"],
        "mailgun_premium_trial": data["mailgun"]["premium"]["free_trial_months"],
        "mailgun_basic_link_validation": data["mailgun"]["basic"]["link_validation"],
        "mailgun_basic_spam_checks": data["mailgun"]["basic"]["spam_checks"],
        "mailgun_premium_link_validation": data["mailgun"]["premium"]["link_validation"],
        "mailgun_premium_spam_checks": data["mailgun"]["premium"]["spam_checks"],
        "litmus_contact_sales_required": data["litmus"]["contact_sales_required"],
        "email_on_acid": data["email_on_acid"],
    }


def atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(content)
    os.replace(temporary, path)


def write_output(name: str, value: str) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output:
            output.write(f"{name}={value}\n")


def report_source(page: dict[str, Any] | None) -> dict[str, Any] | None:
    if page is None:
        return None
    return {
        "requested_url": page["requested_url"],
        "http_status": page["status"],
        "final_url": page["final_url"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default="run-report.json")
    parser.add_argument("--today", help="Override the UTC date for deterministic local tests (YYYY-MM-DD).")
    args = parser.parse_args()
    report_path = Path(args.report)
    if not report_path.is_absolute():
        report_path = ROOT / report_path
    today = args.today or dt.datetime.now(dt.timezone.utc).date().isoformat()
    dt.date.fromisoformat(today)

    report: dict[str, Any] = {
        "checked_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "date": today,
        "status": "manual_review",
        "changed": False,
        "notify": True,
        "sources": {},
        "errors": [],
    }
    source_pages: dict[str, dict[str, Any] | None] = {
        "mailgun": None,
        "litmus": None,
        "email_on_acid": None,
    }
    try:
        current = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        if current.get("schema_version") != 1:
            raise ReviewRequired("Unsupported competitor-prices.json schema version.")
    except Exception as error:
        report["errors"].append(f"Could not read competitor-prices.json: {error}")
        return finish_report(report, report_path)

    extractors = {
        "mailgun": (MAILGUN_URL, extract_mailgun),
        "litmus": (LITMUS_URL, extract_litmus),
        "email_on_acid": (EMAIL_ON_ACID_URL, extract_email_on_acid),
    }
    extracted: dict[str, Any] = {}
    for name, (url, extractor) in extractors.items():
        try:
            page = fetch_page(url)
            source_pages[name] = page
            report["sources"][name] = report_source(page)
            extracted[name] = extractor(page)
        except Exception as error:
            report["sources"].setdefault(name, {"requested_url": url})
            report["errors"].append(f"{name}: {error}")

    if report["errors"] or len(extracted) != len(extractors):
        report["status"] = "manual_review"
        return finish_report(report, report_path)

    candidate = json.loads(json.dumps(current))
    candidate["mailgun"] = extracted["mailgun"]
    candidate["litmus"] = extracted["litmus"]
    candidate["email_on_acid"] = extracted["email_on_acid"]
    report["extracted"] = {
        "mailgun": candidate["mailgun"],
        "litmus": candidate["litmus"],
        "email_on_acid": candidate["email_on_acid"],
    }

    price_changed = _price_snapshot(candidate) != _price_snapshot(current)
    non_price_changed = _non_price_snapshot(candidate) != _non_price_snapshot(current)
    if non_price_changed and not price_changed:
        report["status"] = "manual_review"
        report["errors"].append(
            "A trial, feature, sales-status, or legacy-page fact changed without a clear price change; "
            "the page and verification date were left untouched."
        )
        return finish_report(report, report_path)

    candidate["last_verified"] = today
    try:
        current_page = PAGE_PATH.read_text(encoding="utf-8")
        if price_changed:
            rendered_page = render_page(current_page, candidate)
        else:
            rendered_page = render_page_date_only(current_page, current, today)
        rendered_sitemap = render_sitemap(SITEMAP_PATH.read_bytes(), today)
    except Exception as error:
        report["status"] = "manual_review"
        report["errors"].append(f"Could not safely render the page or sitemap: {error}")
        return finish_report(report, report_path)

    page_changed = rendered_page != PAGE_PATH.read_text(encoding="utf-8")
    data_text = json.dumps(candidate, ensure_ascii=False, indent=2) + "\n"
    data_changed = data_text != DATA_PATH.read_text(encoding="utf-8")
    sitemap_changed = rendered_sitemap != SITEMAP_PATH.read_bytes()
    changed = page_changed or data_changed or sitemap_changed
    if changed:
        atomic_write(PAGE_PATH, rendered_page.encode("utf-8"))
        atomic_write(DATA_PATH, data_text.encode("utf-8"))
        atomic_write(SITEMAP_PATH, rendered_sitemap)

    report["changed"] = changed
    report["price_changed"] = price_changed
    report["status"] = "changed" if price_changed else "checked"
    report["notify"] = price_changed
    report["files_changed"] = [
        name for name, did_change in (
            ("free-pre-send-check.html", page_changed),
            ("competitor-prices.json", data_changed),
            ("sitemap.xml", sitemap_changed),
        ) if did_change
    ]
    report["old_prices"] = _price_snapshot(current)
    report["new_prices"] = _price_snapshot(candidate)
    return finish_report(report, report_path)


def finish_report(report: dict[str, Any], report_path: Path) -> int:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_output("status", str(report.get("status", "manual_review")))
    write_output("changed", str(bool(report.get("changed"))).lower())
    write_output("notify", str(bool(report.get("notify"))).lower())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
