"""GET /summary."""

from __future__ import annotations


def test_summary_totals_the_month_and_breaks_it_down_by_category(client, seeded):
    body = client.get("/summary", params={"month": "2026-06"}).json()

    assert body["month"] == "2026-06"
    # June only: 1650.71 + 2340.00 + 530.60 + 1000.00. May's rent is excluded.
    assert body["total"] == 5521.31

    by_category = {row["category"]: row["total"] for row in body["by_category"]}
    assert by_category == {"Food": 3990.71, "Transport": 530.60, "": 1000.00}
    # Ordered by spend, descending, so the UI chart reads largest-first.
    totals = [row["total"] for row in body["by_category"]]
    assert totals == sorted(totals, reverse=True)


def test_uncategorised_spend_is_its_own_bucket_and_counted_in_the_total(client, seeded):
    body = client.get("/summary", params={"month": "2026-06"}).json()

    blank = [row for row in body["by_category"] if row["category"] == ""]
    assert len(blank) == 1
    assert blank[0]["total"] == 1000.00
    assert body["total"] == sum(row["total"] for row in body["by_category"])


def test_december_does_not_roll_over_into_the_wrong_year(client):
    client.post("/expenses", json={"title": "NYE", "amount": 500, "date": "2026-12-31"})
    client.post("/expenses", json={"title": "Jan", "amount": 900, "date": "2027-01-01"})

    assert client.get("/summary", params={"month": "2026-12"}).json()["total"] == 500.0


def test_a_month_with_no_spend_is_an_empty_summary_not_a_404(client, seeded):
    body = client.get("/summary", params={"month": "2020-01"}).json()

    assert body == {"month": "2020-01", "total": 0.0, "by_category": []}


def test_a_malformed_month_is_rejected(client):
    assert client.get("/summary", params={"month": "2026-13"}).status_code == 422
    assert client.get("/summary", params={"month": "june"}).status_code == 422
    assert client.get("/summary").status_code == 422
