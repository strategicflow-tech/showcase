import json
import unittest
from pathlib import Path

from scripts.update_competitor_prices import (
    ReviewRequired,
    extract_litmus,
    extract_mailgun,
    render_page,
    render_page_date_only,
    render_sitemap,
)


ROOT = Path(__file__).resolve().parents[1]


MAILGUN_SAMPLE = """
Most popular Basic Free for 1 month, then $ 99 /mo
Your recommended plan Basic $ 99 /mo
What's included on Basic Rendering previews Image & link validation (not included)
Spam content analysis (not included) Overages
Most popular Premium Free for 1 month, then $ 199 /mo
Your recommended plan Premium $ 199 /mo
What's included on Premium Rendering previews Image & link validation
Spam content analysis Overages
Free for your first month
"""


def fixture_data():
    return {
        "schema_version": 1,
        "last_verified": "2026-11-23",
        "mailgun": {
            "basic": {
                "monthly_usd": "99",
                "free_trial_months": 1,
                "link_validation": False,
                "spam_checks": False,
            },
            "premium": {
                "monthly_usd": "199",
                "free_trial_months": 1,
                "link_validation": True,
                "spam_checks": True,
            },
        },
        "litmus": {
            "pricing_published": False,
            "contact_sales_required": True,
            "prices": [],
            "pricing_summary": "Pricing is not published on the page; sales contact is required.",
            "final_url": "https://www.litmus.com/contact-sales",
        },
        "email_on_acid": {
            "legacy_pricing_url_status": 404,
            "state": "unavailable",
            "final_url": "https://www.emailonacid.com/plans-pricing/",
        },
        "sources": {},
    }


class CompetitorPriceTests(unittest.TestCase):
    def test_mailgun_extracts_consistent_prices_and_features(self):
        result = extract_mailgun(
            {
                "status": 200,
                "final_url": "https://www.mailgun.com/pricing/inspect/",
                "text": MAILGUN_SAMPLE,
            }
        )
        self.assertEqual(result["basic"]["monthly_usd"], "99")
        self.assertEqual(result["premium"]["monthly_usd"], "199")
        self.assertFalse(result["basic"]["link_validation"])
        self.assertFalse(result["basic"]["spam_checks"])
        self.assertTrue(result["premium"]["link_validation"])
        self.assertTrue(result["premium"]["spam_checks"])
        self.assertEqual(result["premium"]["free_trial_months"], 1)

    def test_mailgun_conflicting_prices_require_review(self):
        text = MAILGUN_SAMPLE.replace("Your recommended plan Basic $ 99 /mo", "Your recommended plan Basic $ 109 /mo")
        with self.assertRaises(ReviewRequired):
            extract_mailgun(
                {
                    "status": 200,
                    "final_url": "https://www.mailgun.com/pricing/inspect/",
                    "text": text,
                }
            )

    def test_mailgun_trial_unit_change_requires_review(self):
        text = MAILGUN_SAMPLE.replace("Free for your first month", "Free for 7 days")
        with self.assertRaises(ReviewRequired):
            extract_mailgun(
                {
                    "status": 200,
                    "final_url": "https://www.mailgun.com/pricing/inspect/",
                    "text": text,
                }
            )

    def test_litmus_contact_sales_is_unpublished(self):
        result = extract_litmus(
            {
                "status": 200,
                "final_url": "https://www.litmus.com/contact-sales",
                "text": "<html><body><h1>Contact sales</h1><p>Tell us about your team.</p></body></html>",
            }
        )
        self.assertFalse(result["pricing_published"])
        self.assertTrue(result["contact_sales_required"])
        self.assertEqual(result["prices"], [])

    def test_litmus_monthly_prices_require_and_capture_plan_names(self):
        result = extract_litmus(
            {
                "status": 200,
                "final_url": "https://www.litmus.com/pricing",
                "text": "<html><body><p>Basic plan $19/month. Premium plan $49/month.</p></body></html>",
            }
        )
        self.assertTrue(result["pricing_published"])
        self.assertEqual(
            [(item["plan"], item["amount"]) for item in result["prices"]],
            [("Basic", "19"), ("Premium", "49")],
        )

    def test_html_slots_and_jsonld_render_from_data(self):
        source = (
            '<script type="application/ld+json" data-competitor-price-jsonld>'
            '{"@graph":[{"@type":"FAQPage","mainEntity":[{"@type":"Question",'
            '"name":"How is this different from Email on Acid, Litmus, or Mailgun Inspect?",'
            '"acceptedAnswer":{"@type":"Answer","text":"old"}}]}]}'
            "</script>"
            '<h1><span data-price-slot="premium_hero_phrase">old</span></h1>'
            '<p data-price-slot="competitor_faq">old</p>'
            '<span data-price-slot="source_date_stamp">old</span>'
            '<span data-price-slot="source_date_long">old</span>'
            '<strong data-price-slot="basic_monthly_price">old</strong>'
            '<strong data-price-slot="premium_monthly_price">old</strong>'
            '<span data-price-slot="basic_trial_phrase">old</span>'
            '<span data-price-slot="premium_trial_phrase">old</span>'
            '<span data-price-slot="basic_feature_summary">old</span>'
            '<span data-price-slot="premium_feature_summary">old</span>'
            '<span data-price-slot="litmus_price_summary">old</span>'
            '<span>Last updated: <span data-price-slot="last_updated">old</span></span>'
        )
        rendered = render_page(source, fixture_data())
        self.assertIn("$199 a month after its free month", rendered)
        self.assertIn("Last updated", rendered)  # Date slot remains valid within its caller's markup.
        self.assertIn("2026-11-23", rendered)
        self.assertNotIn(">old<", rendered)
        json_block = rendered.split("data-competitor-price-jsonld>", 1)[1].split("</script>", 1)[0]
        schema = json.loads(json_block)
        answer = schema["@graph"][0]["mainEntity"][0]["acceptedAnswer"]["text"]
        self.assertIn("$199 per month", answer)
        self.assertIn("23 Nov 2026", answer)

    def test_date_only_render_preserves_every_non_date_value(self):
        data = fixture_data()
        source = (
            '<script type="application/ld+json" data-competitor-price-jsonld>'
            '{"@graph":[{"@type":"FAQPage","mainEntity":[{"@type":"Question",'
            '"name":"How is this different from Email on Acid, Litmus, or Mailgun Inspect?",'
            '"acceptedAnswer":{"@type":"Answer","text":"old"}}]}]}'
            "</script>"
            '<h1><span data-price-slot="premium_hero_phrase">old</span></h1>'
            '<p data-price-slot="competitor_faq">old</p>'
            '<span data-price-slot="source_date_stamp">old</span>'
            '<span data-price-slot="source_date_long">old</span>'
            '<strong data-price-slot="basic_monthly_price">old</strong>'
            '<strong data-price-slot="premium_monthly_price">old</strong>'
            '<span data-price-slot="basic_trial_phrase">old</span>'
            '<span data-price-slot="premium_trial_phrase">old</span>'
            '<span data-price-slot="basic_feature_summary">old</span>'
            '<span data-price-slot="premium_feature_summary">old</span>'
            '<span data-price-slot="litmus_price_summary">old</span>'
            '<span>Last updated: <span data-price-slot="last_updated">old</span></span>'
        )
        baseline = render_page(source, data)
        next_week = render_page_date_only(baseline, data, "2026-11-30")
        next_week_data = fixture_data()
        next_week_data["last_verified"] = "2026-11-30"
        restored = render_page_date_only(next_week, next_week_data, "2026-11-23")
        self.assertEqual(restored, baseline)
        self.assertIn("30 NOV 2026", next_week)
        self.assertIn("$199/mo", next_week)
        self.assertIn("$99/mo", next_week)

    def test_sitemap_updates_only_the_target_date(self):
        source = (
            b'<?xml version="1.0"?><urlset><!-- keep this comment -->'
            b"<url><loc>https://strategicflow.tech/</loc><lastmod>2026-06-27</lastmod></url>"
            b"<url><loc>https://strategicflow.tech/free-pre-send-check.html</loc>"
            b"<lastmod>2026-11-23</lastmod></url></urlset>"
        )
        result = render_sitemap(source, "2026-11-30")
        self.assertIn(b"<!-- keep this comment -->", result)
        self.assertIn(b"<lastmod>2026-06-27</lastmod>", result)
        self.assertIn(b"<lastmod>2026-11-30</lastmod>", result)

    def test_live_page_has_exact_faq_title_and_no_em_or_en_dash(self):
        page = (ROOT / "free-pre-send-check.html").read_text(encoding="utf-8")
        self.assertIn("What this check can and can’t tell you.", page)
        self.assertNotIn("\u2014", page)
        self.assertNotIn("\u2013", page)


if __name__ == "__main__":
    unittest.main()
