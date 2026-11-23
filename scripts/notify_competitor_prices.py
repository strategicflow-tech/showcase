#!/usr/bin/env python3
"""Notify the owner about a price change, manual review, or failed publish."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / "run-report.json"
OWNER_EMAIL = "strategicflow@proton.me"
SENDER = "Strategic Flow <alex@strategicflow.tech>"


def request_json(url: str, *, method: str = "GET", token: str | None = None, payload: Any = None) -> Any:
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    body = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=20) as response:
        response_body = response.read()
        return json.loads(response_body) if response_body else None


def notification(report: dict[str, Any], event: str) -> tuple[str, str]:
    if event == "push_failed":
        title = "[Competitor pricing] Repository push failed"
        lead = "The check found a publishable update, but the automated push to main failed. No force push was attempted."
    elif event == "pages_failed":
        title = "[Competitor pricing] GitHub Pages build request failed"
        lead = "The data update was pushed, but GitHub Pages did not accept the automatic build request."
    elif event == "update_failed":
        title = "[Competitor pricing] Automated check failed"
        lead = "The scheduled pricing check failed before it could complete safely."
    elif report.get("status") == "manual_review":
        title = "[Competitor pricing] Manual review required"
        lead = "The official pages could not be parsed confidently. Competitor prices and verification dates were left unchanged."
    else:
        title = "[Competitor pricing] Prices updated automatically"
        lead = "A clearly verified competitor price or published-pricing status changed. The page and sitemap were updated and pushed."

    lines = [
        lead,
        "",
        f"Run date (UTC): {report.get('date', 'unknown')}",
        f"Check status: {report.get('status', 'unknown')}",
    ]
    errors = report.get("errors") or []
    if errors:
        lines.extend(["", "Details:"])
        lines.extend(f"- {error}" for error in errors)
    old_prices = report.get("old_prices")
    new_prices = report.get("new_prices")
    if old_prices or new_prices:
        lines.extend(["", "Previous pricing facts:", json.dumps(old_prices or {}, ensure_ascii=False, indent=2)])
        lines.extend(["", "Current verified pricing facts:", json.dumps(new_prices or {}, ensure_ascii=False, indent=2)])
    sources = report.get("sources") or {}
    if sources:
        lines.extend(["", "Source responses:"])
        lines.extend(
            f"- {name}: HTTP {details.get('http_status', 'not fetched')} at {details.get('final_url', 'unknown URL')}"
            for name, details in sources.items()
        )
    lines.extend(["", "The complete run report is attached to the GitHub Actions run artifact."])
    return title, "\n".join(lines)


def send_resend(api_key: str, title: str, body: str) -> None:
    payload = {
        "from": SENDER,
        "to": [OWNER_EMAIL],
        "subject": title,
        "text": body,
    }
    request = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"Resend returned HTTP {response.status}.")


def create_or_comment_issue(title: str, body: str) -> str:
    token = os.environ.get("GITHUB_TOKEN")
    repository = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repository:
        raise RuntimeError("GitHub issue notification requires GITHUB_TOKEN and GITHUB_REPOSITORY.")
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    encoded_repo = urllib.parse.quote(repository, safe="/")
    issues = request_json(
        f"{api}/repos/{encoded_repo}/issues?state=open&per_page=100",
        token=token,
    )
    existing = next(
        (
            issue for issue in issues or []
            if "pull_request" not in issue and issue.get("title") == title
        ),
        None,
    )
    if existing:
        request_json(
            f"{api}/repos/{encoded_repo}/issues/{existing['number']}/comments",
            method="POST",
            token=token,
            payload={"body": body},
        )
        return f"updated existing issue #{existing['number']}"
    created = request_json(
        f"{api}/repos/{encoded_repo}/issues",
        method="POST",
        token=token,
        payload={"title": title, "body": body},
    )
    return f"created issue #{created['number']}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--event",
        choices=("auto", "push_failed", "pages_failed", "update_failed"),
        default="auto",
    )
    parser.add_argument("--push-status", default="success")
    parser.add_argument("--pages-status", default="success")
    parser.add_argument("--update-status", default="success")
    args = parser.parse_args()

    try:
        report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        report = {
            "status": "manual_review",
            "date": "unknown",
            "errors": ["The run report could not be read."],
        }

    event = args.event
    if event == "auto":
        if args.update_status != "success":
            event = "update_failed"
        elif args.push_status == "failure":
            event = "push_failed"
        elif args.pages_status == "failure":
            event = "pages_failed"
        elif report.get("status") == "manual_review" or report.get("price_changed"):
            event = "report"
        else:
            print("No notification needed; source facts are unchanged.")
            return 0

    title, body = notification(report, event)
    api_key = os.environ.get("RESEND_API_KEY")
    if api_key:
        try:
            send_resend(api_key, title, body)
            print(f"Owner email sent for event: {event}")
            return 0
        except Exception as error:
            print(f"Resend notification failed; using the GitHub issue fallback ({type(error).__name__}).")
    try:
        result = create_or_comment_issue(title, body)
        print(f"Owner notification {result}.")
        return 0
    except Exception as error:
        print(f"Could not deliver the owner notification ({type(error).__name__}): {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
